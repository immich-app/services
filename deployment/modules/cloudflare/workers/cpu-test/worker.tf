resource "cloudflare_worker" "worker" {
  account_id = var.cloudflare_account_id
  name       = "${var.app_name}-api${local.resource_suffix}"
  logpush    = true
  observability = {
    enabled            = true
    head_sampling_rate = 1
    logs = {
      enabled         = true
      invocation_logs = true
    }
  }
}

resource "terraform_data" "source_hash" {
  input = filesha256("${var.dist_dir}/${var.app_name}/index.js")
}

# Commit B: Commit A confirmed new workers default to `usage_model = bundled`
# (50ms CPU cap) — first cron fired exceededCpu at cpu=50ms. Set
# usage_model = "standard" to lift the cap and re-verify via wrangler tail.
resource "cloudflare_worker_version" "worker" {
  account_id          = var.cloudflare_account_id
  worker_id           = cloudflare_worker.worker.id
  usage_model         = "standard"
  compatibility_date  = "2025-09-16"
  compatibility_flags = ["nodejs_compat"]
  main_module         = "index.js"
  modules = [
    {
      content_file = "${var.dist_dir}/${var.app_name}/index.js"
      content_type = "application/javascript+module"
      name         = "index.js"
    }
  ]
  lifecycle {
    replace_triggered_by = [
      terraform_data.source_hash,
    ]
  }
}

resource "cloudflare_workers_deployment" "worker" {
  account_id  = var.cloudflare_account_id
  script_name = cloudflare_worker.worker.name
  strategy    = "percentage"
  versions = [
    {
      percentage = 100
      version_id = cloudflare_worker_version.worker.id
    }
  ]
}

resource "cloudflare_workers_cron_trigger" "burn" {
  account_id  = var.cloudflare_account_id
  script_name = cloudflare_worker.worker.name
  schedules   = [{ cron = "* * * * *" }]
  depends_on  = [cloudflare_workers_deployment.worker]
}

output "preview_url" {
  value = ""
}
