resource "cloudflare_worker" "worker" {
  account_id = var.cloudflare_account_id
  name       = "${var.app_name}-api${local.resource_suffix}"
  logpush    = true
}

resource "cloudflare_d1_database" "db" {
  account_id = var.cloudflare_account_id
  name       = "fourthwall-integration-${var.env}-${var.stage}"
}

resource "cloudflare_queue" "webhook_processor" {
  account_id = var.cloudflare_account_id
  name       = "fourthwall-integration-webhook-processor-${var.env}-${var.stage}"
}

resource "cloudflare_queue" "fulfillment_processor" {
  account_id = var.cloudflare_account_id
  name       = "fourthwall-integration-fulfillment-processor-${var.env}-${var.stage}"
}

resource "cloudflare_worker_version" "worker" {
  account_id = var.cloudflare_account_id
  worker_id  = cloudflare_worker.worker.id
  bindings = [
    {
      name        = "DB"
      type        = "d1_database"
      database_id = cloudflare_d1_database.db.id
    },
    {
      name     = "WEBHOOK_QUEUE"
      type     = "queue"
      queue_id = cloudflare_queue.webhook_processor.id
    },
    {
      name     = "FULFILLMENT_QUEUE"
      type     = "queue"
      queue_id = cloudflare_queue.fulfillment_processor.id
    },
    {
      name = "FOURTHWALL_API_KEY"
      type = "secret_text"
      text = var.fourthwall_api_key
    },
    {
      name = "KUNAKI_API_USERNAME"
      type = "secret_text"
      text = var.kunaki_api_username
    },
    {
      name = "KUNAKI_API_PASSWORD"
      type = "secret_text"
      text = var.kunaki_api_password
    },
    {
      name = "CDCLICK_API_KEY"
      type = "secret_text"
      text = var.cdclick_api_key
    },
    {
      name = "WEBHOOK_SECRET"
      type = "secret_text"
      text = var.webhook_secret
    }
  ]
  cron_triggers = [
    {
      cron = "0 */15 * * *"
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

# Queue Processor Worker
resource "cloudflare_worker" "queue_processor" {
  account_id = var.cloudflare_account_id
  name       = "${var.app_name}-queue-processor${local.resource_suffix}"
  logpush    = true
}

resource "cloudflare_worker_version" "queue_processor" {
  account_id = var.cloudflare_account_id
  worker_id  = cloudflare_worker.queue_processor.id
  bindings = [
    {
      name        = "DB"
      type        = "d1_database"
      database_id = cloudflare_d1_database.db.id
    },
    {
      name = "FOURTHWALL_API_KEY"
      type = "secret_text"
      text = var.fourthwall_api_key
    },
    {
      name = "KUNAKI_API_USERNAME"
      type = "secret_text"
      text = var.kunaki_api_username
    },
    {
      name = "KUNAKI_API_PASSWORD"
      type = "secret_text"
      text = var.kunaki_api_password
    },
    {
      name = "CDCLICK_API_KEY"
      type = "secret_text"
      text = var.cdclick_api_key
    }
  ]
  queue_consumers = [
    {
      queue_id = cloudflare_queue.webhook_processor.id
      type     = "http_pull"
    },
    {
      queue_id = cloudflare_queue.fulfillment_processor.id
      type     = "http_pull"
    }
  ]
  compatibility_date = "2025-09-09"
  compatibility_flags = ["nodejs_compat"]
  main_module        = "queue-processor.js"
  modules = [
    {
      content_file = "${var.dist_dir}/${var.app_name}/queue-processor.js"
      content_type = "application/javascript+module"
      name         = "queue-processor.js"
    }
  ]
}

resource "cloudflare_workers_deployment" "queue_processor" {
  account_id  = var.cloudflare_account_id
  script_name = cloudflare_worker.queue_processor.name
  strategy    = "percentage"
  versions = [
    {
      percentage = 100
      version_id = cloudflare_worker_version.queue_processor.id
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
