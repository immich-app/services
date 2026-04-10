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

# Bumping this forces the analytics_read token to be destroyed and recreated
# on the next apply. Cloudflare provider v5 has a bug where
# `cloudflare_api_token.value` is only populated immediately after creation
# (see cloudflare/terraform-provider-cloudflare#5045), so we intentionally
# recreate the token whenever we need the value to be freshly available to
# downstream resources.
resource "terraform_data" "analytics_token_generation" {
  input = "4"
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

# Diagnostic output so we can tell whether the token value was successfully
# captured. Never logs the actual value.
output "analytics_token_value_length" {
  value = length(cloudflare_api_token.analytics_read.value)
}
