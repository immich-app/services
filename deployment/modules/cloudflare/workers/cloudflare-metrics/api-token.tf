# Read-only API token used by the cloudflare-metrics worker to query the
# GraphQL Analytics API. Scoped to this account only and limited to the
# "Account Analytics Read" permission group so the worker can't do anything
# destructive with the token if it's ever exfiltrated.

data "cloudflare_api_token_permission_groups_list" "account_analytics_read" {
  name = "Account%20Analytics%20Read"
}

resource "cloudflare_api_token" "analytics_read" {
  name = "cloudflare-metrics-analytics-read${local.resource_suffix}"

  policies = [
    {
      effect = "allow"
      permission_groups = [
        {
          id = data.cloudflare_api_token_permission_groups_list.account_analytics_read.result[0].id
        },
      ]
      resources = jsonencode({
        "com.cloudflare.api.account.${var.cloudflare_account_id}" = "*"
      })
    },
  ]
}

output "analytics_api_token" {
  value     = cloudflare_api_token.analytics_read.value
  sensitive = true
}
