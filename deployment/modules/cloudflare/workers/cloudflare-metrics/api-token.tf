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
}
