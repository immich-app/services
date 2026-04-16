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

resource "cloudflare_worker_version" "worker" {
  account_id = var.cloudflare_account_id
  worker_id  = cloudflare_worker.worker.id
  limits = {
    cpu_ms = 30000
  }
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
      text = cloudflare_api_token.analytics_read.value
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
      terraform_data.source_hash,
      cloudflare_api_token.analytics_read,
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

# Workaround for a bug in the Cloudflare terraform provider:
# `cloudflare_worker_version` has no `usage_model` attribute, so newly
# created workers default to legacy `bundled` mode at the service-env
# level (50 ms CPU cap) regardless of the `limits.cpu_ms` we set. The
# runtime uses the service-env settings, not the version limits, so
# our 29999 ms value is silently ignored until something flips the
# service-env to `standard`. PATCH the services environment directly
# after every deploy to force it.
resource "terraform_data" "force_standard_usage_model" {
  triggers_replace = [
    cloudflare_workers_deployment.worker.id,
  ]

  provisioner "local-exec" {
    # Best-effort — don't fail the whole deploy if this PATCH errors,
    # since the service-env settings are sticky across deploys once set.
    # `|| true` on the end makes any curl failure non-fatal; the response
    # body is still printed so we can see what went wrong in CI logs.
    command = <<-EOT
      HTTP_CODE=$(curl -s -o /tmp/cf-patch-response.json -w "%%{http_code}" -X PATCH \
        "https://api.cloudflare.com/client/v4/accounts/${var.cloudflare_account_id}/workers/services/${cloudflare_worker.worker.name}/environments/production/settings" \
        -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
        -F 'settings={"usage_model":"standard","limits":{"cpu_ms":30000}}') || true
      echo "[usage_model PATCH] HTTP $HTTP_CODE"
      cat /tmp/cf-patch-response.json 2>/dev/null; echo
      if [ "$HTTP_CODE" != "200" ]; then
        echo "::warning::usage_model PATCH returned HTTP $HTTP_CODE — worker may be in bundled mode (50ms CPU cap)"
      fi
    EOT

    environment = {
      CLOUDFLARE_API_TOKEN = var.cloudflare_api_token
    }
  }
}

resource "cloudflare_workers_cron_trigger" "collect" {
  account_id  = var.cloudflare_account_id
  script_name = cloudflare_worker.worker.name
  schedules   = [{ cron = "* * * * *" }]
  depends_on  = [cloudflare_workers_deployment.worker]
}

# Empty preview_url output keeps the shared CI preview-URL collector happy —
# this worker has no custom domain, but the workflow still calls
# `terragrunt output -raw preview_url` for every module.
output "preview_url" {
  value = ""
}
