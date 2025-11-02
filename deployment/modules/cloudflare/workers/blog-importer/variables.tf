variable "stage" {}
variable "env" {}
variable "app_name" {}
variable "cloudflare_account_id" {}
variable "dist_dir" {}

variable "r2_bucket_name" {
  description = "R2 bucket name for static assets"
  type        = string
  default     = "immich-static"
}

variable "r2_public_url" {
  description = "Public URL for R2 bucket"
  type        = string
  default     = "https://static.immich.cloud"
}

variable "outline_webhook_secret" {
  description = "Secret for verifying Outline webhook signatures"
  type        = string
  sensitive   = true
}

variable "outline_base_url" {
  description = "Base URL of the Outline instance"
  type        = string
  default     = "https://app.getoutline.com"
}

variable "github_app_id" {
  description = "GitHub App ID"
  type        = string
}

variable "github_app_private_key" {
  description = "GitHub App private key (PEM format)"
  type        = string
  sensitive   = true
}

variable "github_installation_id" {
  description = "GitHub App installation ID for the immich organization"
  type        = string
}
