variable "tf_state_postgres_conn_str" {
  description = "PostgreSQL connection string for Terraform state"
  type        = string
}

data "terraform_remote_state" "api_keys_state" {
  backend = "pg"

  config = {
    conn_str = var.tf_state_postgres_conn_str
    schema_name = "prod_cloudflare_api_keys"
  }
}

data "terraform_remote_state" "cloudflare_account" {
  backend = "pg"

  config = {
    conn_str = var.tf_state_postgres_conn_str
    schema_name = "prod_cloudflare_account"
  }
}
