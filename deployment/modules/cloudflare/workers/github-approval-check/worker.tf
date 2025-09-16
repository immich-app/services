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
      name = "ALLOWED_USERS_URL"
      type = "plain_text"
      text = var.allowed_users_url
    },
    {
      name = "GITHUB_APP_ID"
      type = "plain_text"
      text = var.github_app_checks_id
    },
    {
      name = "GITHUB_APP_PRIVATE_KEY"
      type = "secret_text"
      text = var.github_app_checks_pem_file
    },
    {
      name = "GITHUB_WEBHOOK_SECRET"
      type = "secret_text"
      text = var.github_checks_webhook_secret
    },
    {
      name = "ENVIRONMENT"
      type = "plain_text"
      text = var.env
    },
    {
      name = "STAGE"
      type = "plain_text"
      text = var.stage
    }
  ]
  compatibility_date = "2025-09-16"
  compatibility_flags = ["nodejs_compat"]
  main_module        = "index.js"
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

data "cloudflare_zone" "immich_app" {
  filter = {
    name = "immich.app"
  }
}

resource "cloudflare_workers_custom_domain" "worker" {
  account_id  = var.cloudflare_account_id
  environment = "production"
  hostname    = module.domain.fqdn
  service     = cloudflare_worker.worker.name
  zone_id     = data.cloudflare_zone.immich_app.zone_id
}

module "domain" {
  source = "git::https://github.com/immich-app/devtools.git//tf/shared/modules/domain?ref=main"

  app_name = var.app_name
  stage    = var.stage
  env      = var.env
  domain   = "immich.app"
}

output "webhook_url" {
  value = "https://${module.domain.fqdn}/webhook"
}
