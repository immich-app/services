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
}

const DEFAULT_LAG_MS = 5 * 60 * 1000;
const DEFAULT_WINDOW_MS = 10 * 60 * 1000;

export class CloudflareMetricsCollector {
  private readonly lagMs: number;
  private readonly windowMs: number;
  private readonly now: () => Date;

  constructor(
    private readonly client: ICloudflareGraphQLClient,
    private readonly accountTag: string,
    private readonly metrics: CloudflareMetricsRepository,
    options: CollectorOptions = {},
  ) {
    this.lagMs = options.lagMs ?? DEFAULT_LAG_MS;
    this.windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
    this.now = options.now ?? (() => new Date());
  }

  getRange(): { start: Date; end: Date } {
    const end = new Date(this.now().getTime() - this.lagMs);
    const start = new Date(end.getTime() - this.windowMs);
    return { start, end };
  }

  async collectAll(datasets: readonly DatasetQuery[]): Promise<CollectionResult[]> {
    const range = this.getRange();
    const results: CollectionResult[] = [];
    for (const dataset of datasets) {
      results.push(await this.collectDataset(dataset, range));
    }
    return results;
  }

  async collectDataset(dataset: DatasetQuery, range: { start: Date; end: Date }): Promise<CollectionResult> {
    const startedAt = performance.now();
    try {
      const rows = await this.client.fetchDataset(this.accountTag, dataset, range);
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
