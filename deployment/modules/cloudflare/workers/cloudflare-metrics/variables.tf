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
