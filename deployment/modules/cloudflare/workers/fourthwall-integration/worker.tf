resource "cloudflare_worker" "worker" {
  account_id = var.cloudflare_account_id
  name       = "${var.app_name}-api${local.resource_suffix}"
  logpush    = true
  observability = {
    enabled = true
    head_sampling_rate = 1
    logs = {
      enabled = true
      head_sampling_rate = 1
      invocation_logs = true
    }
  }
}

resource "terraform_data" "source_hash" {
  input = filesha256("${var.dist_dir}/${var.app_name}/index.js")
}

resource "cloudflare_d1_database" "db" {
  account_id = var.cloudflare_account_id
  name       = "fourthwall-integration${local.resource_suffix}"
  read_replication = {
    mode = "disabled"
  }
}

resource "cloudflare_queue" "webhook_processor" {
  account_id = var.cloudflare_account_id
  queue_name       = "fourthwall-integration-webhook-processor${local.resource_suffix}"
  depends_on = [cloudflare_worker.queue_processor]
}

resource null_resource "webhook_processor_consumer" {
  provisioner "local-exec" {
    on_failure = fail
    when       = create
    command    = <<EOT
      curl --fail-with-body -S -X POST https://api.cloudflare.com/client/v4/accounts/${var.cloudflare_account_id}/queues/${cloudflare_queue.webhook_processor.queue_id}/consumers \
      -H 'Authorization: Bearer ${data.terraform_remote_state.api_keys_state.outputs.terraform_key_cloudflare_account}' \
      -H 'Content-Type: application/json' \
      -d '{
        "script_name": "${cloudflare_worker.queue_processor.name}",
        "queue_id": "${cloudflare_queue.webhook_processor.queue_id}",
        "dead_letter_queue": "${cloudflare_queue.webhook_processor_dlq.queue_name}",
        "type": "worker",
        "settings": {
          "max_retries": 3,
          "max_wait_time_ms": 5000,
          "batch_size": 10,
          "max_concurrency": null,
          "retry_delay": 0
        }
      }'
    EOT
  }
  depends_on = [cloudflare_worker_version.queue_processor, cloudflare_worker_version.worker, cloudflare_queue.webhook_processor]
}

resource "cloudflare_queue" "webhook_processor_dlq" {
  account_id = var.cloudflare_account_id
  queue_name       = "fourthwall-integration-webhook-processor-dlq${local.resource_suffix}"
}

resource "cloudflare_queue" "fulfillment_processor" {
  account_id = var.cloudflare_account_id
  queue_name       = "fourthwall-integration-fulfillment-processor${local.resource_suffix}"

  depends_on = [cloudflare_worker.queue_processor]
}

resource null_resource "fullfillment_processor_consumer" {
  provisioner "local-exec" {
    on_failure = fail
    when       = create
    command    = <<EOT
      curl --fail-with-body -S -X POST https://api.cloudflare.com/client/v4/accounts/${var.cloudflare_account_id}/queues/${cloudflare_queue.fulfillment_processor.queue_id}/consumers \
      -H 'Authorization: Bearer ${data.terraform_remote_state.api_keys_state.outputs.terraform_key_cloudflare_account}' \
      -H 'Content-Type: application/json' \
      -d '{
        "script_name": "${cloudflare_worker.queue_processor.name}",
        "queue_id": "${cloudflare_queue.fulfillment_processor.queue_id}",
        "dead_letter_queue": "${cloudflare_queue.fulfillment_processor_dlq.queue_name}",
        "type": "worker",
        "settings": {
          "max_retries": 3,
          "max_wait_time_ms": 5000,
          "batch_size": 10,
          "max_concurrency": null,
          "retry_delay": 0
        }
      }'
    EOT
  }
  depends_on = [cloudflare_worker_version.queue_processor, cloudflare_worker_version.worker, cloudflare_queue.fulfillment_processor]
}

resource "cloudflare_queue" "fulfillment_processor_dlq" {
  account_id = var.cloudflare_account_id
  queue_name       = "fourthwall-integration-fulfillment-processor-dlq${local.resource_suffix}"
}

resource "cloudflare_queue" "email_processor" {
  account_id = var.cloudflare_account_id
  queue_name       = "fourthwall-integration-email-processor${local.resource_suffix}"
  depends_on = [cloudflare_worker.queue_processor]
}

resource null_resource "email_processor_consumer" {
  provisioner "local-exec" {
    on_failure = fail
    when       = create
    command    = <<EOT
      curl --fail-with-body -S -X POST https://api.cloudflare.com/client/v4/accounts/${var.cloudflare_account_id}/queues/${cloudflare_queue.email_processor.queue_id}/consumers \
      -H 'Authorization: Bearer ${data.terraform_remote_state.api_keys_state.outputs.terraform_key_cloudflare_account}' \
      -H 'Content-Type: application/json' \
      -d '{
        "script_name": "${cloudflare_worker.queue_processor.name}",
        "queue_id": "${cloudflare_queue.email_processor.queue_id}",
        "dead_letter_queue": "${cloudflare_queue.email_processor_dlq.queue_name}",
        "type": "worker",
        "settings": {
          "max_retries": 3,
          "max_wait_time_ms": 5000,
          "batch_size": 5,
          "max_concurrency": null,
          "retry_delay": 0
        }
      }'
    EOT
  }
  depends_on = [cloudflare_worker_version.queue_processor, cloudflare_worker_version.worker, cloudflare_queue.email_processor]
}

resource "cloudflare_queue" "email_processor_dlq" {
  account_id = var.cloudflare_account_id
  queue_name       = "fourthwall-integration-email-processor-dlq${local.resource_suffix}"
}

resource "cloudflare_worker_version" "worker" {
  account_id = var.cloudflare_account_id
  worker_id  = cloudflare_worker.worker.id
  bindings = [
    {
      name        = "DB"
      type        = "d1"
      id = cloudflare_d1_database.db.id
    },
    {
      name     = "WEBHOOK_QUEUE"
      type     = "queue"
      queue_name = cloudflare_queue.webhook_processor.queue_name
    },
    {
      name     = "FULFILLMENT_QUEUE"
      type     = "queue"
      queue_name = cloudflare_queue.fulfillment_processor.queue_name
    },
    {
      name     = "EMAIL_QUEUE"
      type     = "queue"
      queue_name = cloudflare_queue.email_processor.queue_name
    },
    {
      name = "FOURTHWALL_USERNAME"
      type = "secret_text"
      text = var.fourthwall_username
    },
    {
      name = "FOURTHWALL_PASSWORD"
      type = "secret_text"
      text = var.fourthwall_password
    },
    {
      name = "FOURTHWALL_USER_USERNAME"
      type = "secret_text"
      text = var.fourthwall_user_username
    },
    {
      name = "FOURTHWALL_USER_PASSWORD"
      type = "secret_text"
      text = var.fourthwall_user_password
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
      name = "CDCLICK_IDLE_MODE"
      type = "plain_text"
      text = var.cdclick_idle_mode
    },
    {
      name = "WEBHOOK_SECRET"
      type = "secret_text"
      text = var.webhook_secret
    },
    {
      name = "ENVIRONMENT"
      type = "plain_text"
      text = var.env
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
  lifecycle {
    replace_triggered_by = [
      terraform_data.source_hash
    ]
  }
}

resource "cloudflare_workers_cron_trigger" "worker_cron" {
  account_id  = var.cloudflare_account_id
  script_name = cloudflare_worker.worker.name
  schedules   = [ { cron = "0,30 * * * *" } ]
  depends_on = [cloudflare_workers_deployment.queue_processor]
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
  observability = {
    enabled = true
    head_sampling_rate = 1
    logs = {
      enabled = true
      head_sampling_rate = 1
      invocation_logs = true
    }
  }
}

resource "cloudflare_worker_version" "queue_processor" {
  account_id = var.cloudflare_account_id
  worker_id  = cloudflare_worker.queue_processor.id
  bindings = [
    {
      name        = "DB"
      type        = "d1"
      id = cloudflare_d1_database.db.id
    },
    {
      name     = "WEBHOOK_QUEUE"
      type     = "queue"
      queue_name = cloudflare_queue.webhook_processor.queue_name
    },
    {
      name     = "FULFILLMENT_QUEUE"
      type     = "queue"
      queue_name = cloudflare_queue.fulfillment_processor.queue_name
    },
    {
      name     = "EMAIL_QUEUE"
      type     = "queue"
      queue_name = cloudflare_queue.email_processor.queue_name
    },
    {
      name = "FOURTHWALL_USERNAME"
      type = "secret_text"
      text = var.fourthwall_username
    },
    {
      name = "FOURTHWALL_PASSWORD"
      type = "secret_text"
      text = var.fourthwall_password
    },
    {
      name = "FOURTHWALL_USER_USERNAME"
      type = "secret_text"
      text = var.fourthwall_user_username
    },
    {
      name = "FOURTHWALL_USER_PASSWORD"
      type = "secret_text"
      text = var.fourthwall_user_password
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
      name = "CDCLICK_IDLE_MODE"
      type = "plain_text"
      text = var.cdclick_idle_mode
    },
    {
      name = "WEBHOOK_SECRET"
      type = "secret_text"
      text = var.webhook_secret
    },
    {
      name = "ENVIRONMENT"
      type = "plain_text"
      text = var.env
    },
    {
      name = "SMTP_HOST"
      type = "secret_text"
      text = var.smtp_host
    },
    {
      name = "SMTP_PORT"
      type = "secret_text"
      text = var.smtp_port
    },
    {
      name = "SMTP_USER"
      type = "secret_text"
      text = var.smtp_user
    },
    {
      name = "SMTP_PASSWORD"
      type = "secret_text"
      text = var.smtp_password
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
  lifecycle {
    replace_triggered_by = [
      terraform_data.source_hash
    ]
  }
}

# resource "cloudflare_queue_consumer" "webhook_processor" {
#   consumer_id = "webhookprocessor"
#   account_id = var.cloudflare_account_id
#   queue_id = cloudflare_queue.webhook_processor.id
#   dead_letter_queue = cloudflare_queue.webhook_processor_dlq.queue_name
#   script_name = cloudflare_worker.queue_processor.name
#   settings = {
#     batch_size = 50
#     max_concurrency = 10
#     max_retries = 3
#     max_wait_time_ms = 5000
#     retry_delay = 10
#   }
#   type = "worker"
# }
#
# resource "cloudflare_queue_consumer" "fulfillment_processor" {
#   consumer_id = "fulfillmentprocessor"
#   account_id = var.cloudflare_account_id
#   queue_id = cloudflare_queue.fulfillment_processor.id
#   dead_letter_queue = cloudflare_queue.fulfillment_processor_dlq.queue_name
#   script_name = cloudflare_worker.queue_processor.name
#   settings = {
#     batch_size = 50
#     max_concurrency = 10
#     max_retries = 3
#     max_wait_time_ms = 5000
#     retry_delay = 10
#   }
#   type = "worker"
# }

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
