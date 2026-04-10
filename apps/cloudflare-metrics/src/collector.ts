import type { ICloudflareRestClient } from './cloudflare-api.js';
import type { ICloudflareGraphQLClient } from './graphql-client.js';
import { CloudflareGraphQLError } from './graphql-client.js';
import { Metric, type CloudflareMetricsRepository } from './metrics.js';
import type { CollectionResult, DatasetQuery, DatasetRow } from './types.js';

/**
 * Module-level zone name cache, keyed by zoneTag. Cloudflare Workers
 * isolates stay warm for several minutes to hours, so caching Pages zone
 * lookups across invocations avoids paying the ~15-subrequest Pages
 * enumeration cost on every cron tick — which matters a lot when each
 * invocation is already close to the 50-subrequest limit. Resets when the
 * isolate is recycled, which is fine as a cheap TTL.
 */
const globalZoneNameCache = new Map<string, string>();

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
 * Collection window defaults. The cron fires every 5 minutes, and with
 * 1-minute buckets we want enough overlap that missing one cron run still
 * results in every bucket being written at least once. 5 min lag keeps us
 * out of buckets Cloudflare hasn't finalised yet; 12 min window plus the
 * lag means each run touches ~12 minute-buckets, overlapping the previous
 * run by ~7 minutes.
 */
const DEFAULT_LAG_MS = 5 * 60 * 1000;
const DEFAULT_WINDOW_MS = 12 * 60 * 1000;
/**
 * Cap on the number of individual `/zones/{id}` lookups we'll issue per
 * cron tick. Cloudflare Workers caps subrequests at 50/invocation on most
 * plans; between our datasets, bulk REST lookups, zone-scoped queries and
 * the metric flush we're already close to the ceiling. Cold start resolves
 * 8 Pages zones per run, subsequent invocations hit the module-level cache.
 */
const MAX_INDIVIDUAL_ZONE_LOOKUPS_PER_RUN = 8;

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
    for (const dataset of datasets) {
      results.push(await this.collectDataset(dataset, range));
    }
    results.push(await this.collectScheduledInvocations(range));
    return results;
  }

  /**
   * `workersInvocationsScheduled` is a raw event feed rather than a
   * `*AdaptiveGroups` dataset, so it doesn't fit the general dataset
   * pipeline. Each event is a single scheduled (cron) worker invocation;
   * we bucket them client-side by `(script, cron, status, minute)` and emit
   * one `cf_workers_scheduled` point per bucket.
   */
  private async collectScheduledInvocations(range: { start: Date; end: Date }): Promise<CollectionResult> {
    const key = 'workers_scheduled';
    const startedAt = performance.now();
    try {
      const events = await this.client.fetchScheduledInvocations(this.accountTag, range);
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
    } catch (error) {
      const durationMs = performance.now() - startedAt;
      const message = errorMessage(error);
      console.error(`[collector] ${key} failed:`, message);
      this.metrics.push(
        Metric.create('collector_dataset')
          .addTag('dataset', key)
          .addTag('status', 'error')
          .addTag('error', errorTag(error))
          .intField('errors', 1)
          .durationField('duration', durationMs),
      );
      return { dataset: key, rows: 0, points: 0, durationMs, error: message };
    }
  }

  private async populateResourceCache(): Promise<void> {
    this.resourceCache = emptyResourceCache();
    // Seed zones from the module-level cache populated in previous invocations.
    // Pages project zones (resolved via `/zones/{id}`) rarely change so a cross-
    // invocation cache turns their lookups into ~0 subrequests steady-state.
    for (const [tag, name] of globalZoneNameCache) {
      this.resourceCache.zones.set(tag, name);
    }
    if (!this.restClient) {
      return;
    }

    const [d1Result, queuesResult, zonesResult] = await Promise.allSettled([
      this.restClient.listD1Databases(this.accountTag),
      this.restClient.listQueues(this.accountTag),
      this.restClient.listZones(this.accountTag),
    ]);

    this.recordResourceLookup('d1_databases', d1Result, (items) => {
      for (const db of items) {
        if (db.uuid && db.name) {
          this.resourceCache.d1Databases.set(db.uuid, db.name);
        }
      }
    });
    this.recordResourceLookup('queues', queuesResult, (items) => {
      for (const q of items) {
        if (q.queue_id && q.queue_name) {
          this.resourceCache.queues.set(q.queue_id, q.queue_name);
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

  async collectDataset(dataset: DatasetQuery, range: { start: Date; end: Date }): Promise<CollectionResult> {
    if ((dataset.scope ?? 'account') === 'zone') {
      return this.collectZoneScopedDataset(dataset, range);
    }
    const startedAt = performance.now();
    try {
      const rows = await this.client.fetchDataset(this.accountTag, dataset, range);
      if (dataset.field === 'httpRequestsOverviewAdaptiveGroups') {
        // Pages projects get their own zone tag in analytics but are not
        // returned by `/zones?account.id=...`; resolve them individually
        // before emitting so the metric tags carry a human-readable name.
        await this.resolveMissingZones(rows);
      }
      const points = this.emitRows(dataset, rows);
      const durationMs = performance.now() - startedAt;
      this.metrics.push(
        Metric.create('collector_dataset')
          .addTag('dataset', dataset.key)
          .addTag('status', 'success')
          .intField('rows', rows.length)
          .intField('points', points)
          .durationField('duration', durationMs),
      );
      return { dataset: dataset.key, rows: rows.length, points, durationMs };
    } catch (error) {
      const durationMs = performance.now() - startedAt;
      const message = errorMessage(error);
      console.error(`[collector] ${dataset.key} failed:`, message);
      this.metrics.push(
        Metric.create('collector_dataset')
          .addTag('dataset', dataset.key)
          .addTag('status', 'error')
          .addTag('error', errorTag(error))
          .intField('errors', 1)
          .durationField('duration', durationMs),
      );
      return { dataset: dataset.key, rows: 0, points: 0, durationMs, error: message };
    }
  }

  /**
   * Runs a zone-scoped dataset query once per cached zone in parallel.
   * Injects `zoneTag` + `zoneName` into each row before emission so tagging
   * works the same as account-scoped datasets. Individual zone failures are
   * counted per-zone but don't abort the whole dataset.
   */
  private async collectZoneScopedDataset(
    dataset: DatasetQuery,
    range: { start: Date; end: Date },
  ): Promise<CollectionResult> {
    const startedAt = performance.now();
    // Only iterate bulk-listed zones (the 6 real account zones), not the
    // dozens of lazily-resolved Cloudflare Pages project zones. We'd blow
    // through the 50-subrequest Workers limit otherwise.
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

    const results = await Promise.allSettled(
      zones.map(async ([zoneTag, zoneName]) => {
        const rows = await this.client.fetchZoneDataset(zoneTag, dataset, range);
        return { zoneTag, zoneName, rows };
      }),
    );

    let totalRows = 0;
    let totalPoints = 0;
    let zoneErrors = 0;
    let lastError: unknown;
    for (const result of results) {
      if (result.status === 'rejected') {
        zoneErrors++;
        lastError = result.reason;
        console.error(`[collector] ${dataset.key} zone failed:`, errorMessage(result.reason));
        continue;
      }
      const { zoneTag, zoneName, rows } = result.value;
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
      error: zoneErrors === zones.length ? errorMessage(lastError) : undefined,
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
      case 'd1StorageAdaptiveGroups': {
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
