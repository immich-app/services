# Read-only API token used by the cloudflare-metrics worker to query the
# GraphQL Analytics API. Scoped to this account only and limited to the
# "Account Analytics Read" permission group so the worker can't do anything
# destructive with the token if it's ever exfiltrated.
#
# The permission group UUID is hardcoded — listing permission groups requires
# the same user-level privileges the data source would need, and the IDs are
# stable public identifiers.

locals {
  # "Account Analytics Read"
  cloudflare_permission_group_account_analytics_read = "b89a480218d04ceb98b4fe57ca29dc1f"
}

# Bumping the `input` on this resource forces the analytics_read token to be
# destroyed and recreated on the next apply. We use this to work around
# Cloudflare provider v5 issue #5045: the provider only reports
# `cloudflare_api_token.value` in state immediately after creation, and state
# refreshes wipe the attribute to empty. Every time we need a fresh, non-empty
# `.value`, bump `generation` below.
resource "terraform_data" "analytics_token_generation" {
  input = "3"
}

resource "cloudflare_api_token" "analytics_read" {
  provider = cloudflare.bootstrap

  name = "cloudflare-metrics-analytics-read${local.resource_suffix}"

  policies = [
    {
      effect = "allow"
      permission_groups = [
        {
          id = local.cloudflare_permission_group_account_analytics_read
        },
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

# Captures the fresh `.value` each time the api_token is recreated and pins it
# in state, so the worker binding keeps a populated token even after future
# state refreshes wipe `cloudflare_api_token.value`. `triggers_replace` is
# keyed on the token id so this resource gets rebuilt alongside every token
# rotation.
resource "terraform_data" "analytics_token_value" {
  input = cloudflare_api_token.analytics_read.value

  triggers_replace = [cloudflare_api_token.analytics_read.id]

  lifecycle {
    ignore_changes = [input]
  }
}
