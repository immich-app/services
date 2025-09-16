terraform {
  source = "."

  extra_arguments custom_vars {
    commands = get_terraform_commands_that_need_vars()
  }
}

include "root" {
  path = find_in_parent_folders("state.hcl")
}

dependencies {
  paths = ["../cloudflare/workers/github-approval-check"]
}

locals {
  env = get_env("TF_VAR_env")
  stage = get_env("TF_VAR_stage", "")
}

inputs = {
  env = local.env
  stage = local.stage
}

remote_state {
  backend = "pg"

  config = {
    conn_str = get_env("TF_VAR_tf_state_postgres_conn_str")
    schema_name = "services_github_${local.env}${local.stage}"
  }
}
