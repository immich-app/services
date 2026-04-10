variable "stage" {}
variable "env" {}
variable "app_name" {}
variable "cloudflare_account_id" {}
variable "dist_dir" {}

variable "vmetrics_api_token" {
  description = "VMetrics API token used by the worker to push metrics to VictoriaMetrics"
  type        = string
  sensitive   = true
}

# NOTE: The analytics token is provided as an input rather than generated
# inside this module because the Terraform service account does not hold the
# "User API Tokens Write" permission required to call `POST /user/tokens` or
# enumerate permission groups. The token must be created manually in the
# Cloudflare dashboard with the "Account Analytics Read" permission group
# scoped to the target account, then stored in 1Password and referenced via
# `TF_VAR_cloudflare_analytics_api_token` in `deployment/.env`.
variable "cloudflare_analytics_api_token" {
  description = "Read-only Cloudflare API token with Account Analytics Read permission"
  type        = string
  sensitive   = true
  default     = ""
}

variable "grafana_url" {
  description = "Grafana instance URL"
  type        = string
}

variable "grafana_token" {
  description = "Grafana API authentication token"
  type        = string
  sensitive   = true
}
