variable "stage" {}
variable "env" {}
variable "app_name" {}
variable "cloudflare_account_id" {}
variable "dist_dir" {}

variable "migrations_dir" {
  description = "Absolute path to D1 migration SQL files"
  type        = string
}

variable "vmetrics_api_token" {
  description = "VMetrics API token for InfluxDB metrics"
  type        = string
  sensitive   = true
}

variable "github_app_readonly_id" {
  description = "GitHub App ID for the Immich Read-Only app"
  type        = string
}

variable "github_app_readonly_pem_file" {
  description = "GitHub App private key (PEM) for the Immich Read-Only app"
  type        = string
  sensitive   = true
}

variable "github_app_readonly_installation_id" {
  description = "GitHub App installation ID for the Immich Read-Only app"
  type        = string
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
