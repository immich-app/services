import type { ICloudflareRestClient } from './cloudflare-api.js';
import { buildMetric, normalizeTagValue } from './emit.js';
import { CloudflareGraphQLError, type ICloudflareGraphQLClient } from './graphql-client.js';
import { Metric } from './metric.js';
import type { CloudflareMetricsRepository } from './metrics.js';
import { ResourceCacheService } from './resource-cache.js';
import type { CollectionResult, DatasetQuery, DatasetRow } from './types.js';

export interface CollectorOptions {
  /** Cloudflare analytics data lags by a few minutes; this offsets the window end. */
  lagMs?: number;
  windowMs?: number;
  now?: () => Date;
  restClient?: ICloudflareRestClient;
}

// 5m lag avoids querying buckets Cloudflare hasn't finalised yet (pipeline
// delay is typically 2-5m). 3m window overlaps consecutive 1m cron ticks
// so a missed tick doesn't drop data; VictoriaMetrics dedupes the overlap.
const DEFAULT_LAG_MS = 5 * 60 * 1000;
const DEFAULT_WINDOW_MS = 3 * 60 * 1000;

export class CloudflareMetricsCollector {
  private readonly lagMs: number;
  private readonly windowMs: number;
  private readonly now: () => Date;
  private readonly resourceCache: ResourceCacheService;

  constructor(
    private readonly client: ICloudflareGraphQLClient,
    private readonly accountTag: string,
    private readonly metrics: CloudflareMetricsRepository,
    options: CollectorOptions = {},
  ) {
    this.lagMs = options.lagMs ?? DEFAULT_LAG_MS;
    this.windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
    this.now = options.now ?? (() => new Date());
    this.resourceCache = new ResourceCacheService(this.accountTag, this.metrics, this.now, options.restClient);
  }

  getRange(): { start: Date; end: Date } {
    const end = new Date(this.now().getTime() - this.lagMs);
    const start = new Date(end.getTime() - this.windowMs);
    return { start, end };
  }

  async collectAll(datasets: readonly DatasetQuery[]): Promise<CollectionResult[]> {
    await this.resourceCache.populate();
    const range = this.getRange();
    const results: CollectionResult[] = [];

    const accountDatasets = datasets.filter((d) => (d.scope ?? 'account') === 'account');
    const datetimeDatasets = accountDatasets.filter((d) => (d.filterGranularity ?? 'datetime') === 'datetime');
    const dateDatasets = accountDatasets.filter((d) => d.filterGranularity === 'date');
    const zoneDatasets = datasets.filter((d) => d.scope === 'zone');

    results.push(...(await this.collectAccountBatch(datetimeDatasets, range, { includeScheduledInvocations: true })));
    if (dateDatasets.length > 0) {
      results.push(...(await this.collectAccountBatch(dateDatasets, range, { includeScheduledInvocations: false })));
    }
    for (const dataset of zoneDatasets) {
      results.push(await this.collectZoneBatch(dataset, range));
    }

    return results;
  }

  private async collectAccountBatch(
    datasets: readonly DatasetQuery[],
    range: { start: Date; end: Date },
    options: { includeScheduledInvocations: boolean },
  ): Promise<CollectionResult[]> {
    if (datasets.length === 0 && !options.includeScheduledInvocations) {
      return [];
    }
    const results: CollectionResult[] = [];
    const startedAt = performance.now();
    let batchResult: Awaited<ReturnType<ICloudflareGraphQLClient['fetchAccountBatch']>>;
    try {
      batchResult = await this.client.fetchAccountBatch(this.accountTag, datasets, range, options);
    } catch (error) {
      const durationMs = performance.now() - startedAt;
      const message = errorMessage(error);
      console.error('[collector] account batch fetch failed:', message);
      for (const dataset of datasets) {
        this.pushDatasetErrorMetric(dataset.key, error, durationMs, 'batch');
        results.push({ dataset: dataset.key, rows: 0, points: 0, durationMs, error: message });
      }
      if (options.includeScheduledInvocations) {
        this.pushDatasetErrorMetric('workers_scheduled', error, durationMs, 'batch');
        results.push({ dataset: 'workers_scheduled', rows: 0, points: 0, durationMs, error: message });
      }
      return results;
    }

    for (const dataset of datasets) {
      const perStart = performance.now();
      if (batchResult.errors[dataset.key]) {
        const msg = batchResult.errors[dataset.key];
        console.error(`[collector] ${dataset.key} field error:`, msg);
        this.pushDatasetErrorMetric(dataset.key, new Error(msg), performance.now() - perStart);
        results.push({
          dataset: dataset.key,
          rows: 0,
          points: 0,
          durationMs: performance.now() - perStart,
          error: msg,
        });
        continue;
      }
      const rows = batchResult.rows[dataset.key] ?? [];
      if (dataset.field === 'httpRequestsOverviewAdaptiveGroups') {
        // Pages projects have zone tags in analytics but aren't in the
        // bulk /zones list; resolve them individually for human-readable names.
        await this.resolveZonesForRows(rows);
      }
      const points = this.emitRows(dataset, rows);
      const durationMs = performance.now() - perStart;
      this.metrics.push(
        Metric.create('collector_dataset')
          .addTag('dataset', dataset.key)
          .addTag('status', 'success')
          .intField('rows', rows.length)
          .intField('points', points)
          .durationField('duration', durationMs),
      );
      results.push({ dataset: dataset.key, rows: rows.length, points, durationMs });
    }

    if (options.includeScheduledInvocations) {
      results.push(this.emitScheduledInvocations(batchResult));
    }
    return results;
  }

  private emitScheduledInvocations(
    batchResult: Awaited<ReturnType<ICloudflareGraphQLClient['fetchAccountBatch']>>,
  ): CollectionResult {
    const key = 'workers_scheduled';
    const startedAt = performance.now();
    if (batchResult.errors[key]) {
      const msg = batchResult.errors[key];
      console.error(`[collector] ${key} field error:`, msg);
      this.pushDatasetErrorMetric(key, new Error(msg), performance.now() - startedAt);
      return { dataset: key, rows: 0, points: 0, durationMs: performance.now() - startedAt, error: msg };
    }
    const events = batchResult.scheduledInvocations ?? [];
    type Bucket = {
      scriptName: string;
      cron: string;
      status: string;
      minute: string;
      count: number;
      cpuTimeUs: number;
      cpuTimeMax: number;
    };
    const buckets = new Map<string, Bucket>();
    for (const event of events) {
      if (!event.datetime) {
        continue;
      }
      const minute = event.datetime.slice(0, 16) + ':00Z';
      const bucketKey = `${event.scriptName}|${event.cron}|${event.status}|${minute}`;
      let bucket = buckets.get(bucketKey);
      if (!bucket) {
        bucket = {
          scriptName: event.scriptName,
          cron: event.cron,
          status: event.status,
          minute,
          count: 0,
          cpuTimeUs: 0,
          cpuTimeMax: 0,
        };
        buckets.set(bucketKey, bucket);
      }
      bucket.count++;
      bucket.cpuTimeUs += event.cpuTimeUs ?? 0;
      bucket.cpuTimeMax = Math.max(bucket.cpuTimeMax, event.cpuTimeUs ?? 0);
    }

    let points = 0;
    for (const bucket of buckets.values()) {
      const timestamp = new Date(bucket.minute);
      if (Number.isNaN(timestamp.getTime())) {
        continue;
      }
      const metric = Metric.create('cf_workers_scheduled');
      metric.addTag('account_id', this.accountTag);
      if (bucket.scriptName) {
        metric.addTag('script_name', bucket.scriptName);
      }
      if (bucket.cron) {
        metric.addTag('cron', bucket.cron);
      }
      if (bucket.status) {
        metric.addTag('status', bucket.status);
      }
      metric
        .intField('invocations', bucket.count)
        .intField('cpu_time_us_sum', Math.round(bucket.cpuTimeUs))
        .intField('cpu_time_us_avg', Math.round(bucket.cpuTimeUs / bucket.count))
        .intField('cpu_time_us_max', Math.round(bucket.cpuTimeMax))
        .setExportTimestamp(timestamp);
      this.metrics.pushRaw(metric);
      points++;
    }

    const durationMs = performance.now() - startedAt;
    this.metrics.push(
      Metric.create('collector_dataset')
        .addTag('dataset', key)
        .addTag('status', 'success')
        .intField('rows', events.length)
        .intField('points', points)
        .durationField('duration', durationMs),
    );
    return { dataset: key, rows: events.length, points, durationMs };
  }

  private async collectZoneBatch(dataset: DatasetQuery, range: { start: Date; end: Date }): Promise<CollectionResult> {
    const startedAt = performance.now();
    // Only bulk-listed zones (real account zones), not Pages project zones.
    const cache = this.resourceCache.getCache();
    const zones = [...cache.zones].filter(([tag]) => cache.bulkZoneTags.has(tag));
    if (zones.length === 0) {
      this.metrics.push(
        Metric.create('collector_dataset')
          .addTag('dataset', dataset.key)
          .addTag('status', 'skipped')
          .addTag('reason', 'no_zones_in_cache')
          .intField('rows', 0)
          .intField('points', 0)
          .durationField('duration', 0),
      );
      return { dataset: dataset.key, rows: 0, points: 0, durationMs: 0 };
    }

    const zoneTags = zones.map(([tag]) => tag);
    let batchResult: Awaited<ReturnType<ICloudflareGraphQLClient['fetchZoneBatch']>>;
    try {
      batchResult = await this.client.fetchZoneBatch(zoneTags, dataset, range);
    } catch (error) {
      const durationMs = performance.now() - startedAt;
      const message = errorMessage(error);
      console.error(`[collector] ${dataset.key} zone batch fetch failed:`, message);
      this.pushDatasetErrorMetric(dataset.key, error, durationMs, 'zone');
      return { dataset: dataset.key, rows: 0, points: 0, durationMs, error: message };
    }

    let totalRows = 0;
    let totalPoints = 0;
    let zoneErrors = 0;
    for (const [zoneTag, zoneName] of zones) {
      if (batchResult.errors[zoneTag]) {
        zoneErrors++;
        console.error(`[collector] ${dataset.key} zone ${zoneTag} error:`, batchResult.errors[zoneTag]);
        continue;
      }
      const rows = batchResult.rows[zoneTag] ?? [];
      totalRows += rows.length;
      for (const row of rows) {
        row.dimensions = { ...row.dimensions, zoneTag };
        const metric = buildMetric(dataset, row, this.accountTag, cache);
        if (metric) {
          metric.addTag('zone_tag', zoneTag);
          metric.addTag('zone_name', zoneName);
          this.metrics.pushRaw(metric);
          totalPoints++;
        }
      }
    }

    const durationMs = performance.now() - startedAt;
    const status = zoneErrors === 0 ? 'success' : zoneErrors === zones.length ? 'error' : 'partial';
    this.metrics.push(
      Metric.create('collector_dataset')
        .addTag('dataset', dataset.key)
        .addTag('status', status)
        .intField('rows', totalRows)
        .intField('points', totalPoints)
        .intField('zones', zones.length)
        .intField('zone_errors', zoneErrors)
        .durationField('duration', durationMs),
    );
    return {
      dataset: dataset.key,
      rows: totalRows,
      points: totalPoints,
      durationMs,
      error: zoneErrors === zones.length ? 'all zones errored' : undefined,
    };
  }

  private emitRows(dataset: DatasetQuery, rows: DatasetRow[]): number {
    const cache = this.resourceCache.getCache();
    let emitted = 0;
    for (const row of rows) {
      const metric = buildMetric(dataset, row, this.accountTag, cache);
      if (metric) {
        this.metrics.pushRaw(metric);
        emitted++;
      }
    }
    return emitted;
  }

  private async resolveZonesForRows(rows: DatasetRow[]): Promise<void> {
    const missing = new Set<string>();
    for (const row of rows) {
      const tag = normalizeTagValue(row.dimensions?.zoneTag);
      if (tag) {
        missing.add(tag);
      }
    }
    await this.resourceCache.resolveMissingZones(missing);
  }

  private pushDatasetErrorMetric(
    datasetKey: string,
    error: unknown,
    durationMs: number,
    scope: 'batch' | 'field' | 'zone' = 'field',
  ): void {
    this.metrics.push(
      Metric.create('collector_dataset')
        .addTag('dataset', datasetKey)
        .addTag('status', 'error')
        .addTag('error', errorTag(error))
        .addTag('error_scope', scope)
        .addTag('error_message', truncateTag(errorMessage(error), 128))
        .intField('errors', 1)
        .durationField('duration', durationMs),
    );
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof CloudflareGraphQLError) {
    // Include the response body snippet when available — it often contains
    // the real reason (rate limit, auth, etc).
    const body = error.responseBody?.slice(0, 200) ?? '';
    return body ? `${error.message}: ${body}` : error.message;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function errorTag(error: unknown): string {
  if (error instanceof CloudflareGraphQLError) {
    return `graphql_${error.statusCode}`;
  }
  if (error instanceof Error) {
    // Classify common Cloudflare GraphQL error messages into stable tags.
    const msg = error.message.toLowerCase();
    if (msg.includes('rate limit') || msg.includes('throttl')) {
      return 'rate_limited';
    }
    if (msg.includes('timeout') || msg.includes('timed out')) {
      return 'timeout';
    }
    if (msg.includes('unauthorized') || msg.includes('forbidden') || msg.includes('authentication')) {
      return 'auth_error';
    }
    if (msg.includes('not found') || msg.includes('does not exist')) {
      return 'not_found';
    }
    if (msg.includes('internal server error') || msg.includes('internal error')) {
      return 'internal_error';
    }
    return error.name === 'Error' ? 'graphql_field_error' : error.name;
  }
  return 'unknown';
}

/** Truncate a string for use as a metric tag value. */
function truncateTag(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  return value.slice(0, maxLength - 3) + '...';
}
