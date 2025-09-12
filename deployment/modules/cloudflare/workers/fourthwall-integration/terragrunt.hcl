terraform {
  source = "."

  extra_arguments custom_vars {
    commands = get_terraform_commands_that_need_vars()
  }
}

include {
  path = find_in_parent_folders("state.hcl")
}

locals {
  env = get_env("TF_VAR_env")
  stage = get_env("TF_VAR_stage")
  app_name = "fourthwall-integration"
}

inputs = {
  app_name = local.app_name
}

remote_state {
  backend = "pg"

  config = {
    conn_str = get_env("TF_VAR_tf_state_postgres_conn_str")
    schema_name = "services_cloudflare_workers_${local.app_name}_immich_app_${local.env}${local.stage}"
  }
}
