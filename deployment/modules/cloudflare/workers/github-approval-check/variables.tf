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

variable "allowed_users_url" {
  description = "URL to fetch the list of allowed users"
  type        = string
  default     = "https://raw.githubusercontent.com/immich-app/devtools/main/tf/deployment/data/users.json"
}
