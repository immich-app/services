variable "tf_state_postgres_conn_str" {}
variable "stage" {}
variable "env" {}
variable "app_name" {}
variable "cloudflare_account_id" {}
variable "dist_dir" {}

# API Keys and Secrets
variable "fourthwall_api_key" {
  description = "API key for Fourthwall integration"
  type        = string
  sensitive   = true
}

variable "kunaki_api_username" {
  description = "Username for Kunaki API"
  type        = string
  sensitive   = true
}

variable "kunaki_api_password" {
  description = "Password for Kunaki API"
  type        = string
  sensitive   = true
}

variable "cdclick_api_key" {
  description = "API key for CDClick Europe"
  type        = string
  sensitive   = true
}

variable "webhook_secret" {
  description = "Secret for webhook signature validation"
  type        = string
  sensitive   = true
}