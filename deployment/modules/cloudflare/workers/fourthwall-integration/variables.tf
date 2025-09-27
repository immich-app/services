variable "tf_state_postgres_conn_str" {}
variable "stage" {}
variable "env" {}
variable "app_name" {}
variable "cloudflare_account_id" {}
variable "dist_dir" {}

# API Keys and Secrets
variable "fourthwall_username" {
  description = "Username for Fourthwall API"
  type        = string
  sensitive   = true
}

variable "fourthwall_password" {
  description = "Password for Fourthwall API"
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

variable "smtp_host" {
  description = "SMTP server hostname"
  type        = string
  sensitive   = true
}

variable "smtp_port" {
  description = "SMTP server port"
  type        = string
  sensitive   = true
}

variable "smtp_user" {
  description = "SMTP username"
  type        = string
  sensitive   = true
}

variable "smtp_password" {
  description = "SMTP password"
  type        = string
  sensitive   = true
}