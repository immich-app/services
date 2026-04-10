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

  # The `-gen-N` suffix lets us force recreation by bumping the generation.
  # Cloudflare provider v5 has an ongoing bug where `cloudflare_api_token.value`
  # is only populated in state immediately after creation; on any subsequent
  # refresh the provider wipes it (see
  # cloudflare/terraform-provider-cloudflare#5045). The worker binding reads
  # the value via a `terraform_data` capture keyed to the token id, so both
  # resources need to be recreated together to re-capture a fresh value.
  name = "cloudflare-metrics-analytics-read${local.resource_suffix}-gen-1"

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

# Captures the token value at creation time so the worker binding survives
# state refreshes that null out `cloudflare_api_token.value`. The
# `triggers_replace` binding ties this resource's lifecycle to the
# `cloudflare_api_token` id — whenever the token is recreated, this capture
# is too, refreshing the stored value. The `ignore_changes = [input]` guard
# protects the captured value between recreations.
resource "terraform_data" "analytics_token_value" {
  input = cloudflare_api_token.analytics_read.value

  triggers_replace = [cloudflare_api_token.analytics_read.id]

  lifecycle {
    ignore_changes = [input]
  }
}
