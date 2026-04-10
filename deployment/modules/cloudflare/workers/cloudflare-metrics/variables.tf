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

variable "cloudflare_api_token" {
  description = "Bootstrap Cloudflare API token with user-level token write permissions, used only to provision the analytics-read token for this worker. Matches the token used by the devtools api-keys module."
  type        = string
  sensitive   = true
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
