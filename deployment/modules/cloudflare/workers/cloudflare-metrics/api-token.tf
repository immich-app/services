# Read-only API token used by the cloudflare-metrics worker to query the
# GraphQL Analytics API and to enumerate resource metadata (D1 databases,
# queues, zones) that's needed to enrich metric tags with human-readable
# names. Scoped to this account only, read-only permissions.
#
# The permission group UUIDs are looked up dynamically via the bootstrap
# provider, which authenticates with the user-level `var.cloudflare_api_token`
# that already has permission to list/manage API tokens.

data "cloudflare_api_token_permission_groups_list" "all" {
  provider = cloudflare.bootstrap
}

locals {
  cf_permission_group_ids = {
    for g in data.cloudflare_api_token_permission_groups_list.all.result : g.name => g.id
  }

  cloudflare_metrics_permission_group_names = [
    "Account Analytics Read",
    "D1 Read",
    "Queues Read",
  ]
}

# Bumping this forces the analytics_read token to be destroyed and recreated
# on the next apply. Cloudflare provider v5 has a bug where
# `cloudflare_api_token.value` is only populated immediately after creation
# (see cloudflare/terraform-provider-cloudflare#5045), so we intentionally
# recreate the token whenever we need the value to be freshly available to
# downstream resources.
resource "terraform_data" "analytics_token_generation" {
  input = "5"
}

resource "cloudflare_api_token" "analytics_read" {
  provider = cloudflare.bootstrap

  name = "cloudflare-metrics-analytics-read${local.resource_suffix}"

  policies = [
    {
      effect = "allow"
      permission_groups = [
        for name in local.cloudflare_metrics_permission_group_names : {
          id = local.cf_permission_group_ids[name]
        }
      ]
      resources = jsonencode({
        "com.cloudflare.api.account.${var.cloudflare_account_id}" = "*"
      })
    },
  ]

  lifecycle {
    replace_triggered_by = [terraform_data.analytics_token_generation]
  }
}

output "analytics_token_id" {
  value = cloudflare_api_token.analytics_read.id
}
