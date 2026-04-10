# cloudflare-metrics

A Cloudflare Worker that periodically pulls data from the [Cloudflare GraphQL
Analytics API](https://developers.cloudflare.com/analytics/graphql-api/),
enriches it with resource names from the Cloudflare REST API, and writes it
to our VictoriaMetrics stack as InfluxDB line protocol.

Runs on a `*/5 * * * *` cron trigger and uses a lagged sliding window so one
missed cron tick doesn't drop data.

---

## What's here

### Architecture

```
  Cloudflare GraphQL Analytics API
  Cloudflare REST API (D1/queues/zones)
               │
               ▼
  ┌─────────────────────────┐
  │ CloudflareGraphQLClient │  fetchAccountBatch (one request, many datasets)
  │ CloudflareRestClient    │  fetchZoneBatch (one request, many zones)
  └───────────┬─────────────┘
              ▼
  ┌─────────────────────────┐
  │ CloudflareMetricsCollector │
  │  - populates resource cache │  (d1/queue/zone id → name)
  │  - batches account datasets │
  │  - batches zone datasets    │
  │  - enriches tags            │
  │  - aggregates scheduled     │
  │    invocations client-side  │
  └───────────┬─────────────┘
              ▼
  ┌─────────────────────────┐
  │ InfluxMetricsProvider   │  flushes InfluxDB line protocol
  └───────────┬─────────────┘
              ▼
  https://cf-workers.monitoring.<env>.immich.cloud/write
```

### Collection window

- **Granularity**: `datetimeMinute` — the finest grouping the API exposes. Each
  metric point is tagged with its minute bucket as the export timestamp.
- **Cron**: every 5 minutes.
- **Lag**: 5 minutes (Cloudflare's analytics pipeline is typically 2–5 minutes
  behind real time; we lag queries to land in fully-populated buckets).
- **Window**: 12 minutes per run, so each cron tick overlaps the previous run
  by ~7 minutes. VictoriaMetrics dedupes on `(series, timestamp)` so overlap
  is free and missing one cron tick still leaves every bucket written.

### Query batching

Cloudflare Workers caps outbound subrequests at 50 per invocation. We stay
well under that by leveraging GraphQL aliases:

| Kind                   | Before batching    | After batching                                         |
| ---------------------- | ------------------ | ------------------------------------------------------ |
| Account-scope datasets | ~23 requests       | 1–2 requests (by filter granularity)                   |
| Zone-scope datasets    | 1 request per zone | 1 request for all zones                                |
| Scheduled invocations  | 1 separate request | piggybacks on datetime batch                           |
| REST bulk lookups      | 3                  | 3                                                      |
| Per-zone Pages lookups | up to ~17 cold     | ~0 warm (module-level cache), throttled to 20/run cold |
| Metric flush           | 1                  | 1                                                      |
| **Per-tick total**     | ~67 (threw at 50)  | **~9 warm / ≤27 cold**                                 |

### Datasets

24 GraphQL datasets + 1 client-side aggregate, grouped roughly by product:

**Workers**

- `cf_workers_invocations` — `workersInvocationsAdaptive`: requests, errors,
  subrequests, CPU time, wall time, response size (sum/max/p50/p99) by script,
  status, version, usage model
- `cf_workers_subrequests` — `workersSubrequestsAdaptiveGroups`: outbound
  subrequest counts and sizes by hostname, cache status, HTTP status
- `cf_workers_overview` — `workersOverviewRequestsAdaptiveGroups`: account-wide
  cpu time by usage model / status
- `cf_workers_scheduled` — `workersInvocationsScheduled` (client-side bucketed):
  cron invocations, cpu time sum/avg/max per (script, cron, status, minute)
- `cf_pages_functions_invocations` — `pagesFunctionsInvocationsAdaptiveGroups`

**D1**

- `cf_d1_queries` — `d1AnalyticsAdaptiveGroups`: read/write queries, rows
  read/written, query duration. Tagged with `database_name` + `database_id`.
- `cf_d1_queries_detail` — `d1QueriesAdaptiveGroups`: per-query count, rows
  scanned/returned/written, duration p50/p95/p99 grouped by database + error.
- `cf_d1_storage` — `d1StorageAdaptiveGroups`: database size by `database_name`.

**R2**

- `cf_r2_operations` — `r2OperationsAdaptiveGroups`: requests, egress by
  bucket/action/status/storage class
- `cf_r2_storage` — `r2StorageAdaptiveGroups`: object count, payload + metadata
  bytes, upload count by bucket

**KV**

- `cf_kv_operations` — `kvOperationsAdaptiveGroups`: requests, object bytes by
  namespace/action/result
- `cf_kv_storage` — `kvStorageAdaptiveGroups`: key count and total bytes

**Durable Objects**

- `cf_durable_objects_invocations` — requests, errors, response size, wall time
- `cf_durable_objects_periodic` — active time, cpu, duration, errors, rows R/W,
  storage R/W units, subrequests, websocket msgs, active ws connections
- `cf_durable_objects_storage` — account-wide stored bytes
- `cf_durable_objects_sql_storage` — per-namespace SQLite stored bytes
- `cf_durable_objects_subrequests` — uncached request body size per script

**Queues**

- `cf_queue_operations` — billable ops, bytes by queue/action/consumer/outcome.
  Tagged with `queue_name`.
- `cf_queue_backlog` — backlog bytes/messages per queue.
- `cf_queue_consumer` — `queueConsumerMetricsAdaptiveGroups`: consumer
  concurrency per queue.

**Hyperdrive**

- `cf_hyperdrive_queries` — query/connection/origin/client latency, query/result
  bytes by config
- `cf_hyperdrive_pool` — current/max pool size, waiting clients

**HTTP (Zone-level)**

- `cf_http_requests_overview` — `httpRequestsOverviewAdaptiveGroups`: requests,
  bytes, cached requests/bytes, page views, visits by zone/country/protocol/status.
  Tagged with `zone_name` (including lazily-resolved Pages projects).
- `cf_http_requests_detail` — `httpRequestsAdaptiveGroups`, **zone-scoped**:
  detailed per-zone breakdown by method/status/cache/country/protocol with
  count, bytes, visits, TTFB, origin response time. Batched: one GraphQL query
  covers all bulk-listed zones via aliased `zones(filter: {zoneTag: "..."})`
  blocks.

### Resource name enrichment

IDs in the analytics API (`databaseId`, `queueId`, `zoneTag`) are augmented
with human-readable names via three REST calls per cron and a lazy per-zone
fallback:

- `GET /accounts/{id}/d1/database` → `database_name` tag on all `cf_d1_*` metrics
- `GET /accounts/{id}/queues` → `queue_name` tag on all `cf_queue_*` metrics
- `GET /zones?account.id={id}` → `zone_name` tag on all `cf_http_*` metrics
- `GET /zones/{id}` (per unknown `zoneTag`, throttled, module-level cached) →
  resolves Cloudflare Pages project zones that aren't in the bulk list

When a lookup fails the metric still gets the ID tag and falls back gracefully
(e.g. `zone_name` defaults to the zone tag rather than leaving the legend blank).

Per-cron self-metrics live under `cloudflare_metrics_resource_lookup{resource,status,error?}`
so failures are observable in VictoriaMetrics/Grafana.

### Self-metrics

The worker uses the same `CloudflareMetricsRepository` pattern as the other
workers in this repo, emitting:

- `cloudflare_metrics_handle_request` / `cloudflare_metrics_cron_collect` —
  duration / invocation / errors for fetch and scheduled handlers.
- `cloudflare_metrics_cron_summary` — datasets, points, errors per cron run.
- `cloudflare_metrics_cron_error` — tagged `reason` when the cron exits early
  (e.g. missing config).
- `cloudflare_metrics_collector_dataset{dataset,status}` — per-dataset rows,
  points, duration, and error tagged with the error class on failure.
- `cloudflare_metrics_resource_lookup{resource,status,error?}` — D1/queue/zone
  REST lookup outcomes.
- `cloudflare_metrics_http_response` — HTTP response counts by method/path/status.

### Infrastructure

- **Worker**: `apps/cloudflare-metrics/` — TypeScript, built with Wrangler, cron
  trigger every 5 minutes.
- **Terraform**: `deployment/modules/cloudflare/workers/cloudflare-metrics/` —
  worker, version, deployment, cron trigger, Grafana dashboard module, and a
  scoped `cloudflare_api_token` with `Account Analytics Read` + `D1 Read` +
  `Queues Read` + `Zone Read`. The token is provisioned through a
  `cloudflare.bootstrap` provider alias (the same one `devtools/tf/.../api-keys`
  uses) and rotated via a `terraform_data.analytics_token_generation` counter
  so we can get around Cloudflare provider v5 issue
  [#5045](https://github.com/cloudflare/terraform-provider-cloudflare/issues/5045)
  wiping `cloudflare_api_token.value` from state on refresh.
- **Dashboard**: `deployment/.../dashboards/cloudflare-metrics-overview.json`
  (generated by `grafana_dashboard` via the shared module). Rows: Overview,
  Workers, D1, R2, KV, Durable Objects, Queues, HTTP (zone-level), Exporter
  Health, Workers Scheduled (Cron), D1 Query Detail, Queue Consumers, HTTP
  Requests Detail.

### Testing

```bash
pnpm run test              # 58 unit tests covering every layer
pnpm run test:integration  # gated on CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID
pnpm run check             # tsc --noEmit
pnpm run build             # wrangler deploy --dry-run
```

Integration tests hit the real Cloudflare API and validate that every dataset
in the registry comes back with the expected shape (including the
`fetchAccountBatch` partial-response path).

### Local development

```bash
cd apps/cloudflare-metrics
pnpm run dev               # wrangler dev
pnpm run tail              # wrangler tail (requires auth)
```

Local `.dev.vars`:

```
CLOUDFLARE_API_TOKEN=...
CLOUDFLARE_ACCOUNT_ID=...
VMETRICS_API_TOKEN=...
ENVIRONMENT=dev
```

---

## What's missing

### Cloudflare GraphQL datasets we haven't wired up

**Plan-gated (blocked)**

- `firewallEventsAdaptiveGroups` — WAF / rate-limit / custom rules event counts
  by rule/action/country. Returns `authz` / "does not have access to the path"
  at both account and zone scope on our current plan (requires Business or
  Enterprise). When the plan level changes, adding it is a single
  `DatasetQuery` entry using `scope: 'zone'` — see the TODO comment in
  `src/datasets.ts` above `HTTP_REQUESTS_DETAIL`.

**Applicable but not yet implemented (low-hanging fruit)**

- `workersBuildsBuildMinutesAdaptiveGroups` — Workers Builds CI minutes. Empty
  on our account right now; wire it up when we start using Workers Builds.
- `workersAnalyticsEngineAdaptiveGroups` — when/if Immich starts writing to
  Analytics Engine datasets.

**Zone-level datasets we could add via `scope: 'zone'`**
We currently query exactly one zone-level dataset (`httpRequestsAdaptiveGroups`)
and use the batched-zones query pattern for it. The same pattern could add:

- `firewallEvents(Adaptive|Groups)` (once plan permits) — per-zone WAF events
- `cacheReserveOperations/Requests/StorageAdaptiveGroups` — Cache Reserve
- `loadBalancingRequests(Adaptive|Groups)` — Load Balancer traffic
- `healthCheckEvents(Adaptive|Groups)` — per-zone synthetic health checks
- `waitingRoomAnalytics(Adaptive|Groups)` — Waiting Room queues
- `pageShieldReportsAdaptiveGroups` — JS supply-chain alerts
- `dnsAnalytics(Adaptive|Groups)` at the zone level
- `workersZoneInvocationsAdaptiveGroups` /
  `workersZoneSubrequestsAdaptiveGroups` — worker route stats per zone
- `apiGateway*` (4 datasets) — API Gateway analytics
- `emailRouting(Adaptive|Groups)` / `emailSending(Adaptive|Groups)` — if Immich
  starts using Cloudflare Email Routing
- `dmarcReports*` — DMARC aggregate reports

### Cloudflare products not relevant today but easy to add later

Datasets exist in the API but our account has no data for these because we
don't use the products. Adding a dataset entry is trivial when we do:

- **AI / AI Gateway**: `aiInferenceAdaptive(Groups)`, `aiGateway*` (Cache,
  Errors, Requests, Size, AutoRAG)
- **Vectorize**: `vectorizeV2Operations/Queries/Storage/WritesAdaptiveGroups`
- **Browser Rendering** / **Browser Isolation**
- **Workflows**: `workflowsAdaptive(Groups)`
- **Stream / Calls / Video**: `callsStatus`, `liveInputEvents`, `streamCMCD`,
  `videoBuffer/Playback/Quality`, `realtimeKitUsage`
- **Images / Media transformations**: `imagesRequestsAdaptiveGroups`,
  `mediaUniqueTransformations`, `toMarkdownConversion`
- **RUM**: `rumPageloadEvents`, `rumPerformanceEvents`, `rumWebVitals`
- **Zero Trust / Access / Gateway / WARP**: `accessLoginRequests`, all
  `gateway*`, `warpDevice*`, `cloudflareTunnelsAnalytics`, `zeroTrustPrivateNetworkDiscovery`
- **Magic WAN / Transit / IDPS** (a lot of `magic*` and `mconnTelemetry*` datasets)
- **Pipelines** (data ingest): `pipelinesIngestion/Delivery/Operator/Sink/UserErrors`
- **Containers / Cloudchamber**: `containersMetricsAdaptiveGroups`,
  `cloudchamberMetricsAdaptiveGroups`
- **Turnstile** / **Zaraz**: `turnstileAdaptiveGroups`, `zaraz*`

### Things that aren't in the GraphQL API at all

The following would require a separate REST client and different token
permissions if we ever want them:

- **Billing / invoicing** — `/accounts/{id}/billing*`. Monthly spend, quota
  usage against plan caps, invoice history.
- **Plan details and limits** — plan tier, feature gates, current quota usage.
- **Worker deployment history** — `/accounts/{id}/workers/scripts/{name}/deployments`
- **R2 Sippy migration progress** — if we ever use Sippy
- **Uptime / synthetic monitoring results** from the Cloudflare Health Check
  API (distinct from the per-zone `healthCheckEvents` dataset).

### Architectural TODOs

- **Cross-invocation caching beyond zone names.** D1/queue lists are re-fetched
  every cron tick; a module-level cache (like `globalZoneNameCache`) would
  save 2 subrequests per invocation and reduce the cold-start budget even
  further.
- **Datasets with explicit `datetime` filter only.** A few datasets (notably
  `d1QueriesAdaptiveGroups`) support per-query text grouping via a `query`
  dimension. We skip it because of cardinality, but we could expose it behind
  a flag once we decide how to bound the cardinality (e.g. hashed query
  fingerprint + retention).
- **Firewall-gated plan upgrades** — if we move to Business/Enterprise we
  should enable `firewallEventsAdaptiveGroups` and the richer fields in
  `httpRequestsAdaptiveGroups` (bot scores, WAF attack scores, ja3/ja4
  fingerprints).
- **Per-zone HTTP detail currently skips Pages projects.** `collectZoneBatch`
  only iterates zones in `resourceCache.bulkZoneTags` to avoid running ~20
  per-zone queries against Pages projects that Cloudflare doesn't return from
  the bulk `/zones` list. If we ever want HTTP detail for Pages zones, we'd
  need a separate strategy (e.g. query them in a second batch capped at N).
- **Grafana dashboard is a single file.** As we add more datasets the
  `cloudflare-metrics-overview.json` file will become unwieldy; consider
  splitting into per-product dashboards wired up by the shared Grafana module's
  `for_each fileset` pattern.
- **No alerting rules yet.** The metrics are there but we haven't set up
  Grafana alerts (or Prometheus alerting rules) for things like error spikes,
  queue backlog growth, D1 query duration regressions, or the exporter's own
  failures (`collector_dataset{status="error"}` / `resource_lookup{status="error"}`).

### Infra-side TODOs

- **Production deployment.** Currently only the dev PR-28 stage is deployed.
  Once reviewed, merging will roll the worker to `prod` automatically via the
  existing `deploy-prod` CI job — but the Terraform-managed token is per-stage,
  so the prod apply will create a new token rather than reusing the dev one.
- **VictoriaMetrics dedup setting.** We proved the pipeline writes at 1-minute
  granularity after fixing the hardcoded `"interval": "5m"` on the dashboard
  panels. If the dev VM cluster is ever configured with
  `-dedup.minScrapeInterval >= 1m`, the 1-minute data will be collapsed.
  Prod is untested.
- **Log sink for `logpush=true`.** The worker has `logpush = true` set but we
  haven't wired up a destination; `wrangler tail` still works for ad-hoc
  debugging.
