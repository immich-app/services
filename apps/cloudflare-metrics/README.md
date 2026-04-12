# cloudflare-metrics

Cloudflare Worker that pulls analytics from the Cloudflare GraphQL API every minute, enriches with resource names from the REST API, and writes to VictoriaMetrics as InfluxDB line protocol.

## Architecture

```
  Cloudflare GraphQL Analytics API ──► CloudflareGraphQLClient
  Cloudflare REST API (D1/queues/zones) ──► CloudflareRestClient
                    │
                    ▼
           CloudflareMetricsCollector
            ├─ ResourceCacheService (id → name lookups)
            ├─ emit.ts (row → Metric translation)
            └─ graphql-builders.ts (query construction)
                    │
                    ▼
           InfluxMetricsProvider ──► VictoriaMetrics /write
```

## Collection window

| Setting | Value       | Why                                                           |
| ------- | ----------- | ------------------------------------------------------------- |
| Cron    | `* * * * *` | Every minute                                                  |
| Lag     | 5 min       | Cloudflare's analytics pipeline is 2–5 min behind real time   |
| Window  | 3 min       | Overlaps consecutive ticks so a missed cron doesn't drop data |
| Dedup   | Free        | VictoriaMetrics dedupes on `(series, timestamp)`              |

## Datasets

78 datasets across account-scope and zone-scope, covering:

- **Workers**: invocations, subrequests, overview, scheduled (client-side aggregated), analytics engine, builds, VPC, placement, workflows
- **D1**: queries (summary + detail with p50/p95/p99), storage
- **R2**: operations, storage, sippy
- **KV**: operations, storage
- **Durable Objects**: invocations, periodic, storage, SQL storage, subrequests
- **Queues**: operations, backlog, consumer concurrency
- **Hyperdrive**: queries (with count), pool sizes
- **HTTP (zone-scope)**: overview, detail (per-zone batched), cache reserve, logpush health
- **Pages Functions**: invocations with CPU/duration p50/p99
- **AI**: inference, gateway (requests/cache/errors/size), search, autoRAG
- **Vectorize**: operations, queries, storage, writes
- **Browser**: rendering API/sessions/time/events, isolation sessions/actions
- **Stream/Video/Calls**: minutes viewed, CMCD, buffer/playback/quality events, live input, realtime kit, calls usage/TURN
- **Images/toMarkdown**: request counts, conversion stats
- **RUM**: pageload, performance (with FCP/page-load p50/p95/p99), web vitals (CLS/FCP/FID/INP/LCP/TTFB averages + p75/p95)
- **Pipelines**: ingestion, delivery, operator, sink
- **Containers, Turnstile**
- **DNS, Email Routing/Sending, DMARC** (zone-scope)
- **API Gateway sessions, Workers Zone invocations/subrequests** (zone-scope)

See `src/datasets.ts` for the full registry. Each dataset declares its GraphQL field, dimensions, aggregation blocks, tag mappings, and field mappings.

### Skipped datasets

| Dataset                               | Reason                                                                     |
| ------------------------------------- | -------------------------------------------------------------------------- |
| `firewallEventsAdaptiveGroups`        | Plan-gated (Business/Enterprise only)                                      |
| `cdnNetworkAnalyticsAdaptiveGroups`   | Plan-gated                                                                 |
| `zarazTrack/TriggersAdaptiveGroups`   | Incompatible filter shape (`datetimeMinute_geq` instead of `datetime_geq`) |
| `cloudchamberMetricsAdaptiveGroups`   | Duplicate schema of `containersMetrics`                                    |
| `cacheReserveRequestsAdaptiveGroups`  | Plan-gated (zone-scope)                                                    |
| `healthCheckEventsAdaptiveGroups`     | Plan-gated (zone-scope)                                                    |
| `loadBalancingRequestsAdaptiveGroups` | Plan-gated (zone-scope)                                                    |
| `nelReportsAdaptiveGroups`            | Plan-gated (zone-scope)                                                    |
| `pageShieldReportsAdaptiveGroups`     | Plan-gated (zone-scope)                                                    |
| `waitingRoomAnalyticsAdaptiveGroups`  | Plan-gated (zone-scope)                                                    |

## Query batching

Cloudflare Workers caps subrequests at 50 per invocation. Account-scope datasets are batched into chunks of 25 using GraphQL aliases. Zone-scope datasets are batched across all zones in a single request per dataset.

| Metric                         | Cold start | Warm (cached)        |
| ------------------------------ | ---------- | -------------------- |
| REST lookups (D1/queues/zones) | 3          | 0 (10-min TTL cache) |
| GraphQL account batches        | 3 chunks   | 3 chunks             |
| GraphQL date-granularity batch | 1          | 1                    |
| Zone-scope datasets            | ~11        | ~11                  |
| Metric flush                   | 1          | 1                    |
| **Total subrequests**          | **~19**    | **~16**              |

## Resource name enrichment

IDs in the analytics API are enriched with human-readable names via REST lookups:

- `database_name` on `cf_d1_*` metrics (from `/accounts/{id}/d1/database`)
- `queue_name` on `cf_queue_*` metrics (from `/accounts/{id}/queues`)
- `zone_name` on `cf_http_*` metrics (from `/zones?account.id={id}` + per-zone fallback for Pages projects)

Module-level caches survive across isolate invocations (typically 10+ minutes on the paid plan). A 10-minute TTL triggers periodic re-fetches. Failed lookups fall back to stale cached names.

## Self-telemetry

The worker emits its own health metrics alongside the Cloudflare data:

- `cloudflare_metrics_cron_summary` — datasets/points/errors per tick
- `cloudflare_metrics_cron_error{reason}` — early-exit errors
- `cloudflare_metrics_collector_dataset{dataset,status}` — per-dataset rows/points/duration/errors
- `cloudflare_metrics_resource_lookup{resource,status}` — REST lookup outcomes
- `cloudflare_metrics_graphql_client` — requests/error_responses per tick
- `cloudflare_metrics_flush{status}` — bytes/duration/pending buffers (from previous tick)
- `cloudflare_metrics_http_response{method,path,status}` — HTTP handler counts
- `cloudflare_metrics_handle_request` — handler duration/invocation

## Dashboards

20 Grafana dashboards managed via Terraform, in `deployment/.../dashboards/`:

| Dashboard                                      | Template variables              |
| ---------------------------------------------- | ------------------------------- |
| Account Overview                               | —                               |
| Workers                                        | `$script_name`, `$status`       |
| Workers Scheduled                              | `$script_name`, `$cron`         |
| D1                                             | `$database_name`                |
| R2                                             | `$bucket_name`                  |
| KV                                             | `$namespace_id`                 |
| Durable Objects                                | `$script_name`, `$namespace_id` |
| Queues                                         | `$queue_name`                   |
| Hyperdrive                                     | `$config_id`                    |
| HTTP / Zones                                   | `$zone_name`                    |
| Pages Functions                                | `$script_name`                  |
| AI, Vectorize, Browser, Stream, RUM, Pipelines | —                               |
| DNS                                            | `$zone_name`                    |
| Email                                          | `$zone_name`                    |
| Exporter Health                                | —                               |

## Alerts

7 Grafana alert rules in `deployment/.../alerts.tf`, all linked to the exporter-health dashboard:

| Rule                               | Condition                          | Severity |
| ---------------------------------- | ---------------------------------- | -------- |
| Collector Not Running              | No `cron_summary_datasets` for 10m | 1        |
| Collector Cron Error               | `cron_error_count > 0` in 10m      | 1        |
| Dataset Errors Sustained           | `>10` errors in 15m                | 3        |
| Metrics Flush Failing              | `>3` flush errors in 15m           | 1        |
| Pending Flush Buffer Growing       | `>3` stashed bodies for 10m        | 3        |
| GraphQL Subrequest Budget Near Cap | `>40` requests/tick for 10m        | 3        |
| GraphQL Error Responses Sustained  | `>5` error responses in 15m        | 3        |

## File structure

```
src/
  index.ts                    Entry point (wires handlers)
  handlers/
    http.ts                   /health endpoint
    scheduled.ts              Cron handler (collect + flush)
  collector.ts                Orchestration (collectAll → batched account/zone fetches)
  resource-cache.ts           REST resource lookups + module-level caching
  emit.ts                     DatasetRow → Metric translation + tag enrichment
  graphql-client.ts           CloudflareGraphQLClient (HTTP transport + chunking)
  graphql-builders.ts         Query construction (pure functions)
  cloudflare-api.ts           CloudflareRestClient (D1/queues/zones REST)
  metrics.ts                  CloudflareMetricsRepository facade
  metric.ts                   Metric data class
  metric-providers.ts         InfluxMetricsProvider + HeaderMetricsProvider
  flush-state.ts              Retry buffer + last-flush stats (module-level state)
  datasets.ts                 78 DatasetQuery definitions
  types.ts                    Shared types
  deferred.ts                 DeferredRepository (waitUntil helper)
  monitor.ts                  monitorAsyncFunction (duration/invocation wrapper)
```

## Development

```bash
pnpm run dev               # wrangler dev (local)
pnpm run test              # 71 unit tests
pnpm run test:integration  # live API tests (needs CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID)
pnpm run check             # tsc --noEmit
pnpm run build             # wrangler deploy --dry-run
```

Local `.dev.vars`:

```
CLOUDFLARE_API_TOKEN=...
CLOUDFLARE_ACCOUNT_ID=...
VMETRICS_API_TOKEN=...
ENVIRONMENT=dev
```

## Infrastructure

- **Worker**: `apps/cloudflare-metrics/` — TypeScript, Wrangler, every-minute cron
- **Terraform**: `deployment/modules/cloudflare/workers/cloudflare-metrics/` — worker, version, deployment, cron trigger, dashboards, alerts, and a scoped API token with Account Analytics Read + D1 Read + Queues Read + Zone Read
- **CI**: unit tests on every PR, path-filtered integration tests (gated on 1Password credentials), build + deploy-dev on PR, deploy-prod on merge to main
