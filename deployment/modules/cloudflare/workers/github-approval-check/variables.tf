variable "stage" {}
variable "env" {}
variable "app_name" {}
variable "cloudflare_account_id" {}
variable "dist_dir" {}

variable "github_app_checks_id" {
  description = "GitHub App ID"
  type        = string
}

variable "github_app_checks_pem_file" {
  description = "GitHub App private key (PEM format)"
  type        = string
  sensitive   = true
}

variable "github_checks_webhook_secret" {
  description = "GitHub webhook secret for signature verification"
  type        = string
  sensitive   = true
}

variable "allowed_users_repo" {
  description = "Repository (owner/name) holding the list of allowed users, read via the GitHub App"
  type        = string
  default     = "immich-app/core-infra-tf"
}

variable "allowed_users_path" {
  description = "Path to the allowed users file within allowed_users_repo"
  type        = string
  default     = "deployment/data/users.json"
}
