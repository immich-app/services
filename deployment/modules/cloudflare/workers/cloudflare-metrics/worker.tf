resource "cloudflare_worker" "worker" {
  account_id = var.cloudflare_account_id
  name       = "${var.app_name}-api${local.resource_suffix}"
  logpush    = true
}

resource "terraform_data" "source_hash" {
  input = filesha256("${var.dist_dir}/${var.app_name}/index.js")
}

resource "cloudflare_worker_version" "worker" {
  account_id = var.cloudflare_account_id
  worker_id  = cloudflare_worker.worker.id
  bindings = [
    {
      name = "ENVIRONMENT"
      type = "plain_text"
      text = var.env
    },
    {
      name = "CLOUDFLARE_ACCOUNT_ID"
      type = "plain_text"
      text = var.cloudflare_account_id
    },
    {
      name = "CLOUDFLARE_API_TOKEN"
      type = "secret_text"
      text = terraform_data.analytics_token_value.output
    },
    {
      name = "VMETRICS_API_TOKEN"
      type = "secret_text"
      text = var.vmetrics_api_token
    },
  ]
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
      terraform_data.source_hash
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

resource "cloudflare_workers_cron_trigger" "collect" {
  account_id  = var.cloudflare_account_id
  script_name = cloudflare_worker.worker.name
  schedules   = [{ cron = "*/5 * * * *" }]
  depends_on  = [cloudflare_workers_deployment.worker]
}

# Empty preview_url output keeps the shared CI preview-URL collector happy —
# this worker has no custom domain, but the workflow still calls
# `terragrunt output -raw preview_url` for every module.
output "preview_url" {
  value = ""
}
