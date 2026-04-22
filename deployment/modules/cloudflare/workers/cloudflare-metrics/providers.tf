provider "cloudflare" {
  api_token = data.terraform_remote_state.api_keys_state.outputs.terraform_key_cloudflare_account
}

# Separate provider using the bootstrap token (same one the devtools api-keys
# module uses) because the account-scoped token above does not hold the
# "User API Tokens Write" permission required to call `POST /user/tokens`.
# Only the analytics token resource uses this provider.
provider "cloudflare" {
  alias     = "bootstrap"
  api_token = var.cloudflare_api_token
}

provider "grafana" {
  url  = var.grafana_url
  auth = var.grafana_token
}
