import type { ICloudflareRestClient } from './cloudflare-api.js';
import type { ICloudflareGraphQLClient } from './graphql-client.js';
import { CloudflareGraphQLError } from './graphql-client.js';
import { Metric, type CloudflareMetricsRepository } from './metrics.js';
import type { CollectionResult, DatasetQuery, DatasetRow } from './types.js';

/**
 * Module-level caches persisted across Worker isolate invocations.
 * Cloudflare Workers isolates stay warm for several minutes to hours, so
 * these let us skip REST lookups that would otherwise run every cron tick
 * — which matters a lot at 1-minute cron frequency where we want every
 * invocation to be as cheap as possible. Caches reset when the isolate
 * is recycled; that's the effective TTL.
 */
const globalZoneNameCache = new Map<string, string>();
const globalD1NameCache = new Map<string, string>();
const globalQueueNameCache = new Map<string, string>();

interface CachedResourceLookup<T> {
  values: T[];
  loadedAt: number;
}

/**
 * Cache for the full bulk-list responses, keyed by kind. We re-fetch if
 * the cache is older than `RESOURCE_CACHE_TTL_MS` or empty. Keeping the
 * full list (not just id→name) lets us seed the per-cron `resourceCache`
 * cleanly in `populateResourceCache`.
 */
const RESOURCE_CACHE_TTL_MS = 10 * 60 * 1000;
let cachedD1Databases: CachedResourceLookup<{ uuid: string; name: string }> | null = null;
let cachedQueues: CachedResourceLookup<{ queue_id: string; queue_name: string }> | null = null;
let cachedBulkZones: CachedResourceLookup<{ id: string; name: string }> | null = null;

/**
 * Resets all module-level caches. Intended for unit tests so each test
 * gets a fresh view of the rest client; has no use in production code.
 */
export function __resetCollectorCachesForTests(): void {
  globalZoneNameCache.clear();
  globalD1NameCache.clear();
  globalQueueNameCache.clear();
  cachedD1Databases = null;
  cachedQueues = null;
  cachedBulkZones = null;
}

export interface CollectorOptions {
  /**
   * How far behind "now" the end of the collection window should be. Cloudflare
   * analytics data is typically delayed by a few minutes, so we lag the window
   * to make sure each bucket is fully populated before we query it.
   */
  lagMs?: number;
  /**
   * Size of the query window. Defaults to matching the cron interval so each
   * run covers exactly one bucket worth of data.
   */
  windowMs?: number;
  /**
   * Clock override for tests.
   */
  now?: () => Date;
  /**
   * Optional REST client for resolving resource names (D1, queues, zones)
   * that aren't surfaced via GraphQL dimensions. When provided, the
   * collector will fetch the lists once at the start of `collectAll` and
   * enrich metric tags with the resolved names.
   */
  restClient?: ICloudflareRestClient;
}

/**
 * Collection window defaults. The cron fires every 1 minute, so each tick
 * picks up the freshest bucket plus a 2-minute overlap buffer so one
 * missed cron doesn't drop data. 5 min lag keeps us out of buckets
 * Cloudflare hasn't finalised yet (the analytics pipeline delay is
 * typically 2–5 minutes).
 *
 *   [ now - (lag + window), now - lag )
 *   = [ now - 8m, now - 5m )
 *
 * VictoriaMetrics dedupes on (series, timestamp) so the 2-minute overlap
 * between consecutive runs is free.
 */
const DEFAULT_LAG_MS = 5 * 60 * 1000;
const DEFAULT_WINDOW_MS = 3 * 60 * 1000;
/**
 * Upper bound on individual `/zones/{id}` lookups per cron tick. Each
 * lookup is one subrequest, and Cloudflare Workers caps subrequests at
 * 50/invocation. Batching the GraphQL queries frees up most of the
 * budget, but keeping a safety cap here means a one-off spike of new
 * Pages projects can't still blow us over. The module-level
 * `globalZoneNameCache` absorbs the rest over the next couple of ticks.
 */
const MAX_INDIVIDUAL_ZONE_LOOKUPS_PER_RUN = 20;

interface ResourceCache {
  d1Databases: Map<string, string>;
  queues: Map<string, string>;
  /** All known zones: bulk list + lazily-resolved Pages projects. */
  zones: Map<string, string>;
  /**
   * Zones that came from the bulk `/zones?account.id=` list, i.e. real
   * account-owned zones. Zone-scoped datasets only iterate this subset to
   * avoid running per-zone queries against the dozens of Pages project
   * zones (which would blow through the Workers subrequest limit).
   */
  bulkZoneTags: Set<string>;
}

function emptyResourceCache(): ResourceCache {
  return {
    d1Databases: new Map(),
    queues: new Map(),
    zones: new Map(),
    bulkZoneTags: new Set(),
  };
}

export class CloudflareMetricsCollector {
  private readonly lagMs: number;
  private readonly windowMs: number;
  private readonly now: () => Date;
  private readonly restClient?: ICloudflareRestClient;
  private resourceCache: ResourceCache = emptyResourceCache();

  constructor(
    private readonly client: ICloudflareGraphQLClient,
    private readonly accountTag: string,
    private readonly metrics: CloudflareMetricsRepository,
    options: CollectorOptions = {},
  ) {
    this.lagMs = options.lagMs ?? DEFAULT_LAG_MS;
    this.windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
    this.now = options.now ?? (() => new Date());
    this.restClient = options.restClient;
  }

  getRange(): { start: Date; end: Date } {
    const end = new Date(this.now().getTime() - this.lagMs);
    const start = new Date(end.getTime() - this.windowMs);
    return { start, end };
  }

  async collectAll(datasets: readonly DatasetQuery[]): Promise<CollectionResult[]> {
    await this.populateResourceCache();
    const range = this.getRange();
    const results: CollectionResult[] = [];

    // Group account-scope datasets by filter granularity so each group can
    // share a single `$filter` variable in a batched query.
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

  /**
   * Runs a batched `fetchAccountBatch` and emits metrics for each dataset in
   * the response. Per-dataset errors surfaced in the GraphQL `errors` array
   * don't abort the whole batch — other datasets still land in VictoriaMetrics.
   */
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
        this.pushDatasetErrorMetric(dataset.key, error, durationMs);
        results.push({ dataset: dataset.key, rows: 0, points: 0, durationMs, error: message });
      }
      if (options.includeScheduledInvocations) {
        this.pushDatasetErrorMetric('workers_scheduled', error, durationMs);
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
        // Pages projects get their own zone tag in analytics but are not
        // returned by `/zones?account.id=...`; resolve them individually
        // before emitting so the metric tags carry a human-readable name.
        await this.resolveMissingZones(rows);
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

  /**
   * Walks the bucketed scheduled-invocation events from a batch result and
   * emits `cf_workers_scheduled` metric points. Returns a CollectionResult
   * describing the per-dataset outcome for dashboards.
   */
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

  private pushDatasetErrorMetric(datasetKey: string, error: unknown, durationMs: number): void {
    this.metrics.push(
      Metric.create('collector_dataset')
        .addTag('dataset', datasetKey)
        .addTag('status', 'error')
        .addTag('error', errorTag(error))
        .intField('errors', 1)
        .durationField('duration', durationMs),
    );
  }

  private async populateResourceCache(): Promise<void> {
    this.resourceCache = emptyResourceCache();
    // Seed lazily-resolved zone names (Pages projects) from the module-level
    // cache populated in previous invocations — these rarely change.
    for (const [tag, name] of globalZoneNameCache) {
      this.resourceCache.zones.set(tag, name);
    }
    if (!this.restClient) {
      return;
    }

    const restClient = this.restClient;
    const now = this.now().getTime();
    const cacheFresh = <T>(cache: CachedResourceLookup<T> | null): cache is CachedResourceLookup<T> =>
      cache !== null && now - cache.loadedAt < RESOURCE_CACHE_TTL_MS;

    // Use cached bulk responses when fresh, otherwise re-fetch. Each refresh
    // saves 1 subrequest / lookup between calls — meaningful at 1-minute
    // cron frequency.
    const [d1Result, queuesResult, zonesResult] = await Promise.allSettled([
      cacheFresh(cachedD1Databases)
        ? Promise.resolve(cachedD1Databases.values)
        : restClient.listD1Databases(this.accountTag).then((values) => {
            cachedD1Databases = { values, loadedAt: now };
            return values;
          }),
      cacheFresh(cachedQueues)
        ? Promise.resolve(cachedQueues.values)
        : restClient.listQueues(this.accountTag).then((values) => {
            cachedQueues = { values, loadedAt: now };
            return values;
          }),
      cacheFresh(cachedBulkZones)
        ? Promise.resolve(cachedBulkZones.values)
        : restClient.listZones(this.accountTag).then((values) => {
            cachedBulkZones = { values, loadedAt: now };
            return values;
          }),
    ]);

    this.recordResourceLookup('d1_databases', d1Result, (items) => {
      for (const db of items) {
        if (db.uuid && db.name) {
          this.resourceCache.d1Databases.set(db.uuid, db.name);
          globalD1NameCache.set(db.uuid, db.name);
        }
      }
    });
    this.recordResourceLookup('queues', queuesResult, (items) => {
      for (const q of items) {
        if (q.queue_id && q.queue_name) {
          this.resourceCache.queues.set(q.queue_id, q.queue_name);
          globalQueueNameCache.set(q.queue_id, q.queue_name);
        }
      }
    });
    this.recordResourceLookup('zones', zonesResult, (items) => {
      for (const z of items) {
        if (z.id && z.name) {
          this.resourceCache.zones.set(z.id, z.name);
          this.resourceCache.bulkZoneTags.add(z.id);
        }
      }
    });

    // If a REST lookup failed entirely (no cache yet and fetch rejected),
    // fall back to whatever id→name pairs survived from previous isolate
    // invocations via the global caches. Better to emit stale-but-present
    // name tags than empty ones.
    if (d1Result.status === 'rejected') {
      for (const [uuid, name] of globalD1NameCache) {
        this.resourceCache.d1Databases.set(uuid, name);
      }
    }
    if (queuesResult.status === 'rejected') {
      for (const [id, name] of globalQueueNameCache) {
        this.resourceCache.queues.set(id, name);
      }
    }
  }

  private recordResourceLookup<T>(
    resource: string,
    result: PromiseSettledResult<T[]>,
    onSuccess: (items: T[]) => void,
  ): void {
    if (result.status === 'fulfilled') {
      onSuccess(result.value);
      this.metrics.push(
        Metric.create('resource_lookup')
          .addTag('resource', resource)
          .addTag('status', 'success')
          .intField('count', result.value.length),
      );
    } else {
      console.error(`[collector] resource lookup ${resource} failed:`, errorMessage(result.reason));
      this.metrics.push(
        Metric.create('resource_lookup')
          .addTag('resource', resource)
          .addTag('status', 'error')
          .addTag('error', errorTag(result.reason))
          .intField('errors', 1),
      );
    }
  }

  /**
   * Fetches a zone-scoped dataset across every bulk-listed zone in ONE
   * batched GraphQL request. Per-zone errors in the response don't fail
   * the whole batch; they're surfaced in a `partial` status.
   */
  private async collectZoneBatch(dataset: DatasetQuery, range: { start: Date; end: Date }): Promise<CollectionResult> {
    const startedAt = performance.now();
    // Only iterate bulk-listed zones (the real account zones), not the
    // dozens of lazily-resolved Cloudflare Pages project zones. Batching
    // into a single query makes the subrequest cost constant regardless of
    // how many zones we have.
    const zones = [...this.resourceCache.zones].filter(([tag]) => this.resourceCache.bulkZoneTags.has(tag));
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
      this.pushDatasetErrorMetric(dataset.key, error, durationMs);
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
        const metric = this.buildMetric(dataset, row);
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
    let emitted = 0;
    for (const row of rows) {
      const metric = this.buildMetric(dataset, row);
      if (metric) {
        this.metrics.pushRaw(metric);
        emitted++;
      }
    }
    return emitted;
  }

  private buildMetric(dataset: DatasetQuery, row: DatasetRow): Metric | null {
    const timestamp = resolveTimestamp(dataset, row);
    if (!timestamp) {
      return null;
    }

    const metric = Metric.create(dataset.measurement);
    metric.addTag('account_id', this.accountTag);
    metric.setExportTimestamp(timestamp);

    for (const tag of dataset.tags) {
      const raw = row.dimensions?.[tag.source];
      const value = normalizeTagValue(raw);
      if (value !== undefined) {
        metric.addTag(tag.as, value);
      }
    }

    this.applyResourceTags(metric, dataset, row);

    let hasField = false;
    for (const [fieldName, spec] of Object.entries(dataset.fields)) {
      const [block, key] = spec.source;
      let raw: number | null | undefined;
      if (block === '_top') {
        // Read a top-level scalar (e.g. `count` on *AdaptiveGroups rows)
        raw = (row as unknown as Record<string, number | null | undefined>)[key];
      } else {
        const blockData = (row as unknown as Record<string, Record<string, number | null> | undefined>)[block];
        raw = blockData?.[key];
      }
      if (raw === null || raw === undefined) {
        continue;
      }
      const value = spec.scale ? raw * spec.scale : raw;
      if (spec.type === 'float') {
        metric.floatField(fieldName, value);
      } else {
        metric.intField(fieldName, Math.round(value));
      }
      hasField = true;
    }

    if (!hasField) {
      return null;
    }

    return metric;
  }

  /**
   * Fetches any zone ids that aren't already in the cache individually via
   * `/zones/{id}` and adds them. Used to cover Cloudflare Pages project zones
   * (and any other zones that don't show up in the bulk `/zones` listing).
   * Failures are tolerated — missing zones will fall back to their zoneTag in
   * the metric label.
   */
  private async resolveMissingZones(rows: DatasetRow[]): Promise<void> {
    if (!this.restClient) {
      return;
    }
    const missing = new Set<string>();
    for (const row of rows) {
      const tag = normalizeTagValue(row.dimensions?.zoneTag);
      if (tag && !this.resourceCache.zones.has(tag)) {
        missing.add(tag);
      }
    }
    if (missing.size === 0) {
      return;
    }
    // Throttle the number of lookups per invocation so cold starts don't
    // exceed the 50-subrequest limit. The module-level cache will absorb
    // the rest across the next few cron ticks.
    const ids = [...missing].slice(0, MAX_INDIVIDUAL_ZONE_LOOKUPS_PER_RUN);
    const startedAt = performance.now();
    const restClient = this.restClient;
    const results = await Promise.allSettled(ids.map((id) => restClient.getZone(id)));
    let resolved = 0;
    let failed = 0;
    for (const [i, result] of results.entries()) {
      if (result.status === 'fulfilled' && result.value) {
        this.resourceCache.zones.set(ids[i], result.value.name);
        // Persist in the module-level cache so the next isolate invocation
        // skips the lookup.
        globalZoneNameCache.set(ids[i], result.value.name);
        resolved++;
      } else if (result.status === 'rejected') {
        failed++;
      }
    }
    this.metrics.push(
      Metric.create('resource_lookup')
        .addTag('resource', 'zones_individual')
        .addTag('status', failed > 0 ? 'partial' : 'success')
        .intField('requested', ids.length)
        .intField('resolved', resolved)
        .intField('failed', failed)
        .durationField('duration', performance.now() - startedAt),
    );
  }

  /**
   * Adds `<resource>_name` tags based on pre-loaded REST lookups.
   * Keyed on the dataset's GraphQL field so that per-dataset dimensions
   * (e.g. `databaseId` vs `queueId` vs `zoneTag`) only get enriched where
   * relevant.
   */
  private applyResourceTags(metric: Metric, dataset: DatasetQuery, row: DatasetRow): void {
    const dims = row.dimensions ?? {};
    switch (dataset.field) {
      case 'd1AnalyticsAdaptiveGroups':
      case 'd1StorageAdaptiveGroups':
      case 'd1QueriesAdaptiveGroups': {
        const id = normalizeTagValue(dims.databaseId);
        const name = id ? this.resourceCache.d1Databases.get(id) : undefined;
        if (name) {
          metric.addTag('database_name', name);
        }
        break;
      }
      case 'queueMessageOperationsAdaptiveGroups':
      case 'queueBacklogAdaptiveGroups': {
        const id = normalizeTagValue(dims.queueId);
        const name = id ? this.resourceCache.queues.get(id) : undefined;
        if (name) {
          metric.addTag('queue_name', name);
        }
        break;
      }
      case 'httpRequestsOverviewAdaptiveGroups': {
        const tag = normalizeTagValue(dims.zoneTag);
        if (tag) {
          // Always populate `zone_name`, falling back to the zoneTag when the
          // name lookup didn't succeed. This keeps dashboard legends populated
          // for zones we can't resolve (e.g. ex-sub-accounts, zones we no
          // longer own) without leaving the series unlabelled.
          metric.addTag('zone_name', this.resourceCache.zones.get(tag) ?? tag);
        }
        break;
      }
      default:
      // no enrichment for this dataset
    }
  }
}

function resolveTimestamp(dataset: DatasetQuery, row: DatasetRow): Date | null {
  const dimension = dataset.timestampDimension ?? 'datetimeMinute';
  const raw = row.dimensions?.[dimension];
  if (raw === null || raw === undefined) {
    return null;
  }
  const str = String(raw);
  // `date` dimension is "YYYY-MM-DD" — treat as UTC midnight.
  if (dimension === 'date') {
    return new Date(`${str}T00:00:00Z`);
  }
  const date = new Date(str);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return date;
}

function normalizeTagValue(raw: unknown): string | undefined {
  if (raw === null || raw === undefined) {
    return undefined;
  }
  if (typeof raw === 'string') {
    return raw === '' ? undefined : raw;
  }
  if (typeof raw === 'number' || typeof raw === 'boolean') {
    return String(raw);
  }
  return undefined;
}

function errorMessage(error: unknown): string {
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
    return error.name;
  }
  return 'unknown';
}
