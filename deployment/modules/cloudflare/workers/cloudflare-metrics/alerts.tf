locals {
  # Must match the folder_name input passed to `module.grafana` in dashboards.tf.
  grafana_folder_name = var.stage != "" ? "cloudflare-metrics (${var.stage})" : "cloudflare-metrics"
  # Mirrors the regex inside the shared grafana module
  # (devtools//tf/shared/modules/grafana/grafana.tf): lowercase, anything
  # that isn't a-z or 0-9 becomes "-".
  dashboards_folder_uid = replace(lower(local.grafana_folder_name), "/[^a-z\\d]/", "-")

  prometheus_datasource_uid = "36979063-5384-4eb9-8679-565a727cbc13"

  # The worker's own script name as it appears in cf_workers_invocations.
  # Must match the cloudflare_worker.worker.name resource.
  worker_script_name = "${var.app_name}-api${local.resource_suffix}"

  # All exporter-health alerts link back to panels on the exporter-health
  # dashboard. The panel IDs are pinned in the 9000 range inside the
  # dashboard generator (apps/cloudflare-metrics generate-dashboards.py) so
  # reordering panels doesn't break the alert → panel links.
  exporter_health_uid = "cf-exporter-health"
  alert_panels = {
    collector_liveness   = 9001
    cron_errors          = 9002
    dataset_errors       = 9003
    flush_errors         = 9004
    pending_flush        = 9005
    graphql_requests     = 9006
    graphql_err_response = 9007
  }
}

resource "grafana_rule_group" "cloudflare_metrics_alerts" {
  org_id             = 1
  name               = "Cloudflare Metrics Exporter"
  folder_uid         = local.dashboards_folder_uid
  interval_seconds   = 60
  disable_provenance = true

  # 1) Collector stopped running entirely. `cron_summary_datasets` is pushed
  #    unconditionally once per successful tick in the scheduled handler, so
  #    any gap in the series means the handler is wedged, crashing, or
  #    missing its token. The threshold never trips in practice — it's just
  #    there to give the rule a condition; the real signal is NoData →
  #    Alerting.
  rule {
    name      = "Collector Not Running"
    condition = "C"

    data {
      ref_id         = "A"
      datasource_uid = local.prometheus_datasource_uid
      relative_time_range {
        from = 600
        to   = 0
      }
      model = jsonencode({
        datasource    = { type = "prometheus", uid = local.prometheus_datasource_uid }
        editorMode    = "code"
        expr          = "max_over_time(cloudflare_metrics_cron_summary_datasets[10m])"
        instant       = true
        intervalMs    = 60000
        legendFormat  = "datasets"
        maxDataPoints = 43200
        refId         = "A"
      })
    }
    data {
      ref_id         = "C"
      datasource_uid = "__expr__"
      relative_time_range {
        from = 0
        to   = 0
      }
      model = jsonencode({
        datasource = { type = "__expr__", uid = "__expr__" }
        expression = "A"
        refId      = "C"
        type       = "threshold"
        conditions = [{
          evaluator = { params = [0], type = "lt" }
          operator  = { type = "and" }
          query     = { params = ["C"] }
          reducer   = { params = [], type = "last" }
          type      = "query"
        }]
        intervalMs    = 1000
        maxDataPoints = 43200
      })
    }

    no_data_state  = "Alerting"
    exec_err_state = "Error"
    for            = "10m"
    annotations = {
      __dashboardUid__ = local.exporter_health_uid
      __panelId__      = tostring(local.alert_panels.collector_liveness)
      summary          = "Cloudflare metrics collector is not running"
      description      = "No cloudflare_metrics_cron_summary_datasets datapoints in the last 10 minutes — the scheduled handler is wedged, crashing, or missing its Cloudflare API token."
    }
    labels    = { severity = "1" }
    is_paused = false
  }

  # 2) Per-tick cron exception. Any cron_error surfaces either a missing
  #    config or a thrown exception during collection.
  rule {
    name      = "Collector Cron Error"
    condition = "C"

    data {
      ref_id         = "A"
      datasource_uid = local.prometheus_datasource_uid
      relative_time_range {
        from = 600
        to   = 0
      }
      model = jsonencode({
        datasource    = { type = "prometheus", uid = local.prometheus_datasource_uid }
        editorMode    = "code"
        expr          = "sum(sum_over_time(cloudflare_metrics_cron_error_count[10m]))"
        instant       = true
        intervalMs    = 60000
        legendFormat  = "errors"
        maxDataPoints = 43200
        refId         = "A"
      })
    }
    data {
      ref_id         = "C"
      datasource_uid = "__expr__"
      relative_time_range {
        from = 0
        to   = 0
      }
      model = jsonencode({
        datasource = { type = "__expr__", uid = "__expr__" }
        expression = "A"
        refId      = "C"
        type       = "threshold"
        conditions = [{
          evaluator = { params = [0], type = "gt" }
          operator  = { type = "and" }
          query     = { params = ["C"] }
          reducer   = { params = [], type = "last" }
          type      = "query"
        }]
        intervalMs    = 1000
        maxDataPoints = 43200
      })
    }

    no_data_state  = "OK"
    exec_err_state = "OK"
    for            = "1m"
    annotations = {
      __dashboardUid__ = local.exporter_health_uid
      __panelId__      = tostring(local.alert_panels.cron_errors)
      summary          = "Cloudflare metrics collector threw an exception"
      description      = "cron_error_count was incremented in the last 10 minutes — collection threw or the handler booted without its Cloudflare credentials."
    }
    labels    = { severity = "1" }
    is_paused = false
  }

  # 3) Sustained per-dataset errors. A handful here and there are expected
  #    on datasets for products we don't use; this catches real breakage
  #    like plan changes or renamed fields.
  rule {
    name      = "Collector Dataset Errors Sustained"
    condition = "C"

    data {
      ref_id         = "A"
      datasource_uid = local.prometheus_datasource_uid
      relative_time_range {
        from = 900
        to   = 0
      }
      model = jsonencode({
        datasource    = { type = "prometheus", uid = local.prometheus_datasource_uid }
        editorMode    = "code"
        expr          = "max(sum by (dataset) (sum_over_time(cloudflare_metrics_collector_dataset_errors[15m])))"
        instant       = true
        intervalMs    = 60000
        legendFormat  = "errors"
        maxDataPoints = 43200
        refId         = "A"
      })
    }
    data {
      ref_id         = "C"
      datasource_uid = "__expr__"
      relative_time_range {
        from = 0
        to   = 0
      }
      model = jsonencode({
        datasource = { type = "__expr__", uid = "__expr__" }
        expression = "A"
        refId      = "C"
        type       = "threshold"
        conditions = [{
          evaluator = { params = [10], type = "gt" }
          operator  = { type = "and" }
          query     = { params = ["C"] }
          reducer   = { params = [], type = "last" }
          type      = "query"
        }]
        intervalMs    = 1000
        maxDataPoints = 43200
      })
    }

    no_data_state  = "OK"
    exec_err_state = "OK"
    for            = "10m"
    annotations = {
      __dashboardUid__ = local.exporter_health_uid
      __panelId__      = tostring(local.alert_panels.dataset_errors)
      summary          = "Collector dataset errors sustained"
      description      = "A single dataset has had more than 10 errors in the last 15 minutes. Check the exporter-health dashboard to see which dataset is failing."
    }
    labels    = { severity = "3" }
    is_paused = false
  }

  # 4) Flush to VictoriaMetrics is failing. This isn't immediately
  #    data-loss — failed bodies get stashed and retried on the next tick —
  #    but sustained failures will eventually hit the 10 MB stash cap and
  #    drop points.
  rule {
    name      = "Metrics Flush Failing"
    condition = "C"

    data {
      ref_id         = "A"
      datasource_uid = local.prometheus_datasource_uid
      relative_time_range {
        from = 900
        to   = 0
      }
      model = jsonencode({
        datasource    = { type = "prometheus", uid = local.prometheus_datasource_uid }
        editorMode    = "code"
        expr          = "sum(sum_over_time(cloudflare_metrics_flush_errors[15m]))"
        instant       = true
        intervalMs    = 60000
        legendFormat  = "errors"
        maxDataPoints = 43200
        refId         = "A"
      })
    }
    data {
      ref_id         = "C"
      datasource_uid = "__expr__"
      relative_time_range {
        from = 0
        to   = 0
      }
      model = jsonencode({
        datasource = { type = "__expr__", uid = "__expr__" }
        expression = "A"
        refId      = "C"
        type       = "threshold"
        conditions = [{
          evaluator = { params = [3], type = "gt" }
          operator  = { type = "and" }
          query     = { params = ["C"] }
          reducer   = { params = [], type = "last" }
          type      = "query"
        }]
        intervalMs    = 1000
        maxDataPoints = 43200
      })
    }

    no_data_state  = "OK"
    exec_err_state = "OK"
    for            = "10m"
    annotations = {
      __dashboardUid__ = local.exporter_health_uid
      __panelId__      = tostring(local.alert_panels.flush_errors)
      summary          = "Metrics flush to VictoriaMetrics is failing"
      description      = "More than 3 flush errors in the last 15 minutes. The worker is stashing bodies for retry; the stash is capped at 10 MB before it starts dropping the oldest. Check VictoriaMetrics / vmauth health."
    }
    labels    = { severity = "1" }
    is_paused = false
  }

  # 5) Pending flush buffer growing. Catches cases where failures are
  #    briefly under the rate threshold but the backlog is still climbing.
  rule {
    name      = "Pending Flush Buffer Growing"
    condition = "C"

    data {
      ref_id         = "A"
      datasource_uid = local.prometheus_datasource_uid
      relative_time_range {
        from = 900
        to   = 0
      }
      model = jsonencode({
        datasource    = { type = "prometheus", uid = local.prometheus_datasource_uid }
        editorMode    = "code"
        expr          = "max(cloudflare_metrics_flush_pending_buffers)"
        instant       = true
        intervalMs    = 60000
        legendFormat  = "buffers"
        maxDataPoints = 43200
        refId         = "A"
      })
    }
    data {
      ref_id         = "C"
      datasource_uid = "__expr__"
      relative_time_range {
        from = 0
        to   = 0
      }
      model = jsonencode({
        datasource = { type = "__expr__", uid = "__expr__" }
        expression = "A"
        refId      = "C"
        type       = "threshold"
        conditions = [{
          evaluator = { params = [3], type = "gt" }
          operator  = { type = "and" }
          query     = { params = ["C"] }
          reducer   = { params = [], type = "last" }
          type      = "query"
        }]
        intervalMs    = 1000
        maxDataPoints = 43200
      })
    }

    no_data_state  = "OK"
    exec_err_state = "OK"
    for            = "10m"
    annotations = {
      __dashboardUid__ = local.exporter_health_uid
      __panelId__      = tostring(local.alert_panels.pending_flush)
      summary          = "Pending flush buffer growing"
      description      = "The worker has stashed more than 3 failed flush bodies waiting for retry. Something is preventing the VM write endpoint from draining them."
    }
    labels    = { severity = "3" }
    is_paused = false
  }

  # 6) Subrequest budget near the Workers 50/invocation cap. We currently
  #    burn ~16 per tick; alert if we ever approach the ceiling so we know
  #    to re-chunk before hitting the limit in production.
  rule {
    name      = "GraphQL Subrequest Budget Near Cap"
    condition = "C"

    data {
      ref_id         = "A"
      datasource_uid = local.prometheus_datasource_uid
      relative_time_range {
        from = 600
        to   = 0
      }
      model = jsonencode({
        datasource    = { type = "prometheus", uid = local.prometheus_datasource_uid }
        editorMode    = "code"
        expr          = "max(cloudflare_metrics_graphql_client_requests)"
        instant       = true
        intervalMs    = 60000
        legendFormat  = "requests"
        maxDataPoints = 43200
        refId         = "A"
      })
    }
    data {
      ref_id         = "C"
      datasource_uid = "__expr__"
      relative_time_range {
        from = 0
        to   = 0
      }
      model = jsonencode({
        datasource = { type = "__expr__", uid = "__expr__" }
        expression = "A"
        refId      = "C"
        type       = "threshold"
        conditions = [{
          evaluator = { params = [40], type = "gt" }
          operator  = { type = "and" }
          query     = { params = ["C"] }
          reducer   = { params = [], type = "last" }
          type      = "query"
        }]
        intervalMs    = 1000
        maxDataPoints = 43200
      })
    }

    no_data_state  = "OK"
    exec_err_state = "OK"
    for            = "10m"
    annotations = {
      __dashboardUid__ = local.exporter_health_uid
      __panelId__      = tostring(local.alert_panels.graphql_requests)
      summary          = "GraphQL subrequest count approaching Workers cap"
      description      = "A cron tick issued more than 40 GraphQL subrequests (Workers paid-plan cap is 50). Add more datasets into the same batched chunk or raise ACCOUNT_BATCH_CHUNK_SIZE before hitting the ceiling."
    }
    labels    = { severity = "3" }
    is_paused = false
  }

  # 7) GraphQL error-response rate. Our batched query shares chunks, so a
  #    wrong field name surfaces as every dataset in that chunk failing.
  #    Treat any sustained error-response rate as a deployment smell.
  rule {
    name      = "GraphQL Error Responses Sustained"
    condition = "C"

    data {
      ref_id         = "A"
      datasource_uid = local.prometheus_datasource_uid
      relative_time_range {
        from = 900
        to   = 0
      }
      model = jsonencode({
        datasource    = { type = "prometheus", uid = local.prometheus_datasource_uid }
        editorMode    = "code"
        expr          = "sum(sum_over_time(cloudflare_metrics_graphql_client_error_responses[15m]))"
        instant       = true
        intervalMs    = 60000
        legendFormat  = "error responses"
        maxDataPoints = 43200
        refId         = "A"
      })
    }
    data {
      ref_id         = "C"
      datasource_uid = "__expr__"
      relative_time_range {
        from = 0
        to   = 0
      }
      model = jsonencode({
        datasource = { type = "__expr__", uid = "__expr__" }
        expression = "A"
        refId      = "C"
        type       = "threshold"
        conditions = [{
          evaluator = { params = [5], type = "gt" }
          operator  = { type = "and" }
          query     = { params = ["C"] }
          reducer   = { params = [], type = "last" }
          type      = "query"
        }]
        intervalMs    = 1000
        maxDataPoints = 43200
      })
    }

    no_data_state  = "OK"
    exec_err_state = "OK"
    for            = "10m"
    annotations = {
      __dashboardUid__ = local.exporter_health_uid
      __panelId__      = tostring(local.alert_panels.graphql_err_response)
      summary          = "GraphQL error responses sustained"
      description      = "More than 5 GraphQL responses with errors[] in the last 15 minutes. This usually means a batched chunk contains an invalid field name; check the exporter-health dashboard."
    }
    labels    = { severity = "3" }
    is_paused = false
  }

  # 8) Collector worker crashing (exceededResources, OOM, etc). This queries
  #    the Cloudflare-reported error count for our own worker script — data
  #    that the collector itself writes to VictoriaMetrics from the analytics
  #    API. Because it's 5-minute-lagged analytics data written by whichever
  #    tick succeeds, it catches sustained crash loops that our self-telemetry
  #    alerts miss (since self-telemetry isn't emitted when the handler crashes).
  rule {
    name      = "Collector Worker Crash Rate"
    condition = "C"

    data {
      ref_id         = "A"
      datasource_uid = local.prometheus_datasource_uid
      relative_time_range {
        from = 1800
        to   = 0
      }
      model = jsonencode({
        datasource    = { type = "prometheus", uid = local.prometheus_datasource_uid }
        editorMode    = "code"
        expr          = "sum(sum_over_time(cf_workers_invocations_errors{script_name=\"${local.worker_script_name}\"}[30m]))"
        instant       = true
        intervalMs    = 60000
        legendFormat  = "errors"
        maxDataPoints = 43200
        refId         = "A"
      })
    }
    data {
      ref_id         = "C"
      datasource_uid = "__expr__"
      relative_time_range {
        from = 0
        to   = 0
      }
      model = jsonencode({
        datasource = { type = "__expr__", uid = "__expr__" }
        expression = "A"
        refId      = "C"
        type       = "threshold"
        conditions = [{
          evaluator = { params = [3], type = "gt" }
          operator  = { type = "and" }
          query     = { params = ["C"] }
          reducer   = { params = [], type = "last" }
          type      = "query"
        }]
        intervalMs    = 1000
        maxDataPoints = 43200
      })
    }

    no_data_state  = "OK"
    exec_err_state = "OK"
    for            = "5m"
    annotations = {
      __dashboardUid__ = local.exporter_health_uid
      __panelId__      = tostring(local.alert_panels.collector_liveness)
      summary          = "Collector worker is crashing"
      description      = "More than 3 cf_workers_invocations_errors for the collector's own script in the last 30 minutes. The worker is likely hitting exceededResources (CPU/memory limit) or another runtime crash. Check the isolate age panel and Cloudflare dashboard for the script."
    }
    labels    = { severity = "1" }
    is_paused = false
  }

  # 9) CPU time approaching the limit. With the ceiling at 30s, sustained
  #    p99 > 1s means the worker is doing more work than expected and could
  #    eventually hit exceededResources again if it keeps climbing.
  rule {
    name      = "Collector CPU Time High"
    condition = "C"

    data {
      ref_id         = "A"
      datasource_uid = local.prometheus_datasource_uid
      relative_time_range {
        from = 900
        to   = 0
      }
      model = jsonencode({
        datasource    = { type = "prometheus", uid = local.prometheus_datasource_uid }
        editorMode    = "code"
        expr          = "max(cf_workers_invocations_cpu_time_us_p99{script_name=\"${local.worker_script_name}\"})"
        instant       = true
        intervalMs    = 60000
        legendFormat  = "cpu_p99"
        maxDataPoints = 43200
        refId         = "A"
      })
    }
    data {
      ref_id         = "C"
      datasource_uid = "__expr__"
      relative_time_range {
        from = 0
        to   = 0
      }
      model = jsonencode({
        datasource = { type = "__expr__", uid = "__expr__" }
        expression = "A"
        refId      = "C"
        type       = "threshold"
        conditions = [{
          evaluator = { params = [1000000], type = "gt" }
          operator  = { type = "and" }
          query     = { params = ["C"] }
          reducer   = { params = [], type = "last" }
          type      = "query"
        }]
        intervalMs    = 1000
        maxDataPoints = 43200
      })
    }

    no_data_state  = "OK"
    exec_err_state = "OK"
    for            = "10m"
    annotations = {
      __dashboardUid__ = local.exporter_health_uid
      __panelId__      = tostring(local.alert_panels.collector_liveness)
      summary          = "Collector CPU time is high"
      description      = "p99 CPU time for the collector worker has been above 1s for 10 minutes. The CPU limit is 30s but sustained high usage may indicate a problem. Check the workers dashboard for the script."
    }
    labels    = { severity = "3" }
    is_paused = false
  }
}
