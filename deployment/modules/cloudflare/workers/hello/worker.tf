resource "cloudflare_worker" "worker" {
  account_id = var.cloudflare_account_id
  name       = "${var.app_name}-api${local.resource_suffix}"
  logpush    = true
}

resource "cloudflare_worker_version" "worker" {
  account_id = var.cloudflare_account_id
  worker_id  = cloudflare_worker.worker.id
  bindings = [
    {
      name = "EXAMPLE_BINDING"
      type = "plain_text"
      text = "example_value"
    }
  ]
  compatibility_date = "2025-09-09"
  compatibility_flags = ["nodejs_compat"]
  main_module        = "index.js"
  modules = [
    {
      content_file = "${var.dist_dir}/${var.app_name}/index.js"
      content_type = "application/javascript+module"
      name         = "index.js"
    }
  ]
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
    name = "immich.cloud"
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
  domain   = "immich.cloud"
}
