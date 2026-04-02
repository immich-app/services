resource "random_password" "webhook_secret" {
  length  = 32
  special = false
}

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
      name = "VERSION_DB"
      type = "d1"
      id   = cloudflare_d1_database.version.id
    },
    {
      name = "VMETRICS_API_TOKEN"
      type = "secret_text"
      text = var.vmetrics_api_token
    },
    {
      name = "GITHUB_APP_ID"
      type = "plain_text"
      text = var.github_app_readonly_id
    },
    {
      name = "GITHUB_APP_PRIVATE_KEY"
      type = "secret_text"
      text = var.github_app_readonly_pem_file
    },
    {
      name = "GITHUB_APP_INSTALLATION_ID"
      type = "plain_text"
      text = var.github_app_readonly_installation_id
    },
    {
      name = "GITHUB_WEBHOOK_SECRET"
      type = "secret_text"
      text = random_password.webhook_secret.result
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

resource "cloudflare_workers_cron_trigger" "sync" {
  account_id  = var.cloudflare_account_id
  script_name = cloudflare_worker.worker.name
  schedules   = [{ cron = "*/30 * * * *" }, { cron = "0 3 * * *" }]
  depends_on  = [cloudflare_workers_deployment.worker]
}

data "cloudflare_zone" "immich_cloud" {
  filter = {
    name = "immich.cloud"
  }
}

resource "cloudflare_workers_custom_domain" "worker" {
  account_id  = var.cloudflare_account_id
  environment = "production"
  hostname    = module.domain.fqdn
  service     = cloudflare_worker.worker.name
  zone_id     = data.cloudflare_zone.immich_cloud.zone_id
  depends_on  = [cloudflare_workers_deployment.worker]
}

module "domain" {
  source = "git::https://github.com/immich-app/devtools.git//tf/shared/modules/domain?ref=main"

  app_name = var.app_name
  stage    = var.stage
  env      = var.env
  domain   = "immich.cloud"
}

output "preview_url" {
  value = "https://${module.domain.fqdn}"
}

output "webhook_url" {
  value = "https://${module.domain.fqdn}/webhook"
}

output "github_webhook_secret" {
  value     = random_password.webhook_secret.result
  sensitive = true
}
