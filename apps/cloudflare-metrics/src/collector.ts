import type { ICloudflareRestClient } from './cloudflare-api.js';
import type { ICloudflareGraphQLClient } from './graphql-client.js';
import { CloudflareGraphQLError } from './graphql-client.js';
import { Metric, type CloudflareMetricsRepository } from './metrics.js';
import type { CollectionResult, DatasetQuery, DatasetRow } from './types.js';

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

const DEFAULT_LAG_MS = 5 * 60 * 1000;
const DEFAULT_WINDOW_MS = 10 * 60 * 1000;

interface ResourceCache {
  d1Databases: Map<string, string>;
  queues: Map<string, string>;
  zones: Map<string, string>;
}

function emptyResourceCache(): ResourceCache {
  return {
    d1Databases: new Map(),
    queues: new Map(),
    zones: new Map(),
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
    return results;
  }

  private async populateResourceCache(): Promise<void> {
    this.resourceCache = emptyResourceCache();
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
      const blockData = (row as unknown as Record<string, Record<string, number | null> | undefined>)[block];
      const raw = blockData?.[key];
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
    const ids = [...missing];
    const startedAt = performance.now();
    const restClient = this.restClient;
    const results = await Promise.allSettled(ids.map((id) => restClient.getZone(id)));
    let resolved = 0;
    let failed = 0;
    for (const [i, result] of results.entries()) {
      if (result.status === 'fulfilled' && result.value) {
        this.resourceCache.zones.set(ids[i], result.value.name);
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
  const dimension = dataset.timestampDimension ?? 'datetimeFiveMinutes';
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
