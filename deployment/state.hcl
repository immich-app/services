locals {
  tf_state_postgres_conn_str = get_env("TF_VAR_tf_state_postgres_conn_str")
}

remote_state {
  backend = "pg"

  config = {
    conn_str = local.tf_state_postgres_conn_str
  }
}

errors {
  retry "transient" {
    retryable_errors   = [".*"]
    max_attempts       = 3
    sleep_interval_sec = 30
  }
}

inputs = {
  tf_state_postgres_conn_str = local.tf_state_postgres_conn_str
}