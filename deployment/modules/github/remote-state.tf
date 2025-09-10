data "terraform_remote_state" "api_keys_state" {
  backend = "pg"

  config = {
    conn_str    = var.tf_state_postgres_conn_str
    schema_name = "prod_cloudflare_api_keys"
  }
}

data "terraform_remote_state" "github_approval_check" {
  backend = "pg"

  config = {
    conn_str    = var.tf_state_postgres_conn_str
    schema_name = "services_cloudflare_workers_github-approval-check_immich_app_${var.env}${var.stage}"
  }
}
