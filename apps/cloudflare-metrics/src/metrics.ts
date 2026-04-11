import { Point } from '@influxdata/influxdb-client';
import { type AsyncFn, type MonitorOptions, type Operation, monitorAsyncFunction } from './monitor.js';

export type MetricFieldType = 'int' | 'float' | 'duration';

export class Metric {
  private _tags = new Map<string, string>();
  private _timestamp = performance.now();
  private _exportTimestamp: Date | undefined;
  private _fields = new Map<string, { value: number; type: MetricFieldType }>();
  private constructor(private _name: string) {}

  static create(name: string) {
    return new Metric(name);
  }

  get tags() {
    return this._tags;
  }

  get timestamp() {
    return this._timestamp;
  }

  get exportTimestamp() {
    return this._exportTimestamp;
  }

  get fields() {
    return this._fields;
  }

  get name() {
    return this._name;
  }

  prefixName(prefix: string) {
    if (!this._name.startsWith(`${prefix}_`)) {
      this._name = `${prefix}_${this._name}`;
    }
  }

  addTag(key: string, value: string) {
    this._tags.set(key, value);
    return this;
  }

  addTags(tags: Record<string, string>) {
    for (const [key, value] of Object.entries(tags)) {
      this._tags.set(key, value);
    }
    return this;
  }

  durationField(key: string, duration?: number) {
    this._fields.set(key, { value: duration ?? performance.now() - this._timestamp, type: 'duration' });
    return this;
  }

  intField(key: string, value: number) {
    this._fields.set(key, { value, type: 'int' });
    return this;
  }

  floatField(key: string, value: number) {
    this._fields.set(key, { value, type: 'float' });
    return this;
  }

  /**
   * Override the timestamp written to the metrics backend. When unset the
   * metrics provider uses the time at which the point is flushed.
   */
  setExportTimestamp(date: Date) {
    this._exportTimestamp = date;
    return this;
  }
}

export interface IMetricsProviderRepository {
  pushMetric(metric: Metric): void;
  flush(): void | Promise<void>;
}

export interface IMetricsRepository {
  monitorAsyncFunction<T extends AsyncFn>(
    operation: Operation,
    call: T,
    options?: MonitorOptions,
  ): (...args: Parameters<T>) => Promise<Awaited<ReturnType<T>>>;
  push(metric: Metric): void;
}

export class HeaderMetricsProvider implements IMetricsProviderRepository {
  private _metrics: string[] = [];

  pushMetric(metric: Metric) {
    for (const [label, { value, type }] of metric.fields) {
      if (type === 'duration') {
        const suffix = label === 'duration' ? '' : `_${label.replace('_duration', '')}`;
        this._metrics.push(`${metric.name}${suffix};dur=${value}`);
      }
    }
  }

  getTimingHeader() {
    return this._metrics.join(', ');
  }

  flush() {
    console.log(this._metrics.join(', '));
  }
}

function getMetricsWriteUrl(environment: string): string {
  if (environment === 'prod') {
    return 'https://cf-workers.monitoring.immich.cloud/write';
  }
  return `https://cf-workers.monitoring.${environment || 'dev'}.immich.cloud/write`;
}

/**
 * Module-level buffer for metrics whose flush attempt failed. Persisted
 * across Worker isolate invocations (each isolate stays alive for minutes
 * to hours) so a transient VictoriaMetrics outage doesn't drop the current
 * cron's data — the next successful flush prepends the stashed body and
 * both land atomically.
 *
 * Capped at a generous 10 MB to avoid unbounded growth under sustained
 * outages; beyond that we drop the oldest buffer rather than run the
 * Worker out of memory.
 */
const pendingFlushBuffers: string[] = [];
const MAX_PENDING_FLUSH_BYTES = 10 * 1024 * 1024;

/**
 * Stats recorded by the previous call to `InfluxMetricsProvider.flush`. Kept
 * at module scope so the next cron tick can pull them in as self-telemetry
 * (you can't observe a flush while you're inside it). `null` until the first
 * flush completes.
 */
export interface LastFlushStats {
  bytes: number;
  durationMs: number;
  status: 'ok' | 'error';
  pendingBuffers: number;
  pendingBytes: number;
}
let lastFlushStats: LastFlushStats | null = null;

export function takeLastFlushStats(): LastFlushStats | null {
  const stats = lastFlushStats;
  lastFlushStats = null;
  return stats;
}

/**
 * Test-only helper. Clears the module-level flush retry buffer and the
 * stashed last-flush stats so each test starts from a clean slate — the
 * real isolate lifetime is minutes to hours so production code naturally
 * shares state across requests, but tests run against a single worker
 * isolate across many `it` blocks and need to reset by hand.
 */
export function __resetMetricsModuleStateForTests(): void {
  pendingFlushBuffers.length = 0;
  lastFlushStats = null;
}

export class InfluxMetricsProvider implements IMetricsProviderRepository {
  private metrics: string[] = [];
  private writeUrl: string;

  constructor(
    private influxApiToken: string,
    private environment: string,
  ) {
    this.writeUrl = getMetricsWriteUrl(environment);
  }

  pushMetric(metric: Metric) {
    const point = new Point(metric.name);
    for (const [key, value] of metric.tags) {
      point.tag(key, value);
    }
    for (const [key, { value, type }] of metric.fields) {
      if (type === 'float') {
        point.floatField(key, value);
      } else {
        point.intField(key, value);
      }
    }
    const exportTimestamp = metric.exportTimestamp;
    if (exportTimestamp) {
      point.timestamp(exportTimestamp);
    }
    const line = point.toLineProtocol()?.toString();
    if (line) {
      this.metrics.push(line);
    }
  }

  get pendingCount(): number {
    return this.metrics.length;
  }

  async flush() {
    const startedAt = performance.now();
    const currentBody = this.metrics.join('\n');
    this.metrics = [];

    // Build the POST body from every stashed retry + the current body,
    // but leave `pendingFlushBuffers` untouched until we know the POST
    // succeeded. Keeping the entries separate lets the eviction loop drop
    // oldest-first when the total crosses the byte cap; if we merged
    // them on every flush the array would only ever have one element and
    // the cap would never fire.
    const parts: string[] = [...pendingFlushBuffers];
    if (currentBody) {
      parts.push(currentBody);
    }
    if (parts.length === 0) {
      return;
    }
    const body = parts.join('\n');
    let status: 'ok' | 'error' = 'ok';

    if (this.environment !== 'prod') {
      console.log(body);
    }
    if (!this.influxApiToken) {
      // No token (local/dev): treat as a successful flush for cleanup.
      pendingFlushBuffers.length = 0;
      this.recordFlushStats(body, performance.now() - startedAt, status);
      return;
    }
    try {
      const response = await fetch(this.writeUrl, {
        method: 'POST',
        body,
        headers: { Authorization: `Token ${this.influxApiToken}` },
      });
      await response.body?.cancel();
      if (response.ok) {
        // Success: every stashed body was included in this POST, so we
        // can clear the whole backlog at once.
        pendingFlushBuffers.length = 0;
      } else {
        console.error('Failed to push metrics', response.status, response.statusText);
        if (currentBody) {
          this.stashFailedFlush(currentBody);
        }
        status = 'error';
      }
    } catch (error) {
      console.error('Metric flush threw', error);
      if (currentBody) {
        this.stashFailedFlush(currentBody);
      }
      status = 'error';
    }

    this.recordFlushStats(body, performance.now() - startedAt, status);
  }

  private recordFlushStats(body: string, durationMs: number, status: 'ok' | 'error'): void {
    lastFlushStats = {
      bytes: body.length,
      durationMs,
      status,
      pendingBuffers: pendingFlushBuffers.length,
      pendingBytes: pendingFlushBuffers.reduce((acc, b) => acc + b.length, 0),
    };
  }

  private stashFailedFlush(body: string): void {
    // Append the newly-failed body as its own entry so the eviction loop
    // can drop the oldest when the backlog crosses the byte cap. Previously
    // the flush path merged every stashed entry into a single body before
    // re-stashing it, which left the array at length 1 and made the
    // `length > 1` eviction guard unreachable.
    pendingFlushBuffers.push(body);
    let total = pendingFlushBuffers.reduce((acc, b) => acc + b.length, 0);
    while (total > MAX_PENDING_FLUSH_BYTES && pendingFlushBuffers.length > 1) {
      const dropped = pendingFlushBuffers.shift();
      total -= dropped?.length ?? 0;
      console.warn('[metrics] dropped buffered flush body over cap');
    }
  }
}

export class CloudflareMetricsRepository implements IMetricsRepository {
  private readonly defaultTags: Record<string, string>;

  constructor(
    private operationPrefix: string,
    request: Request,
    private metricsProviders: IMetricsProviderRepository[],
    environment?: string,
  ) {
    const cf = request.cf as IncomingRequestCfProperties | undefined;
    this.defaultTags = {
      environment: environment ?? '',
      continent: cf?.continent ?? '',
      colo: cf?.colo ?? '',
      asOrg: cf?.asOrganization ?? '',
    };
  }

  monitorAsyncFunction<T extends AsyncFn>(
    operation: Operation,
    call: T,
    options: MonitorOptions = {},
  ): (...args: Parameters<T>) => Promise<Awaited<ReturnType<T>>> {
    operation = { ...operation, tags: { ...operation.tags, ...this.defaultTags } };
    return monitorAsyncFunction(
      this.operationPrefix,
      operation,
      call,
      (metric) => {
        for (const provider of this.metricsProviders) {
          provider.pushMetric(metric);
        }
      },
      options,
    );
  }

  push(metric: Metric) {
    metric.prefixName(this.operationPrefix);
    metric.addTags(this.defaultTags);
    for (const provider of this.metricsProviders) {
      provider.pushMetric(metric);
    }
  }

  /**
   * Push a metric without prefixing it or merging in default tags. Used for
   * Cloudflare analytics data where the measurement name is fully qualified
   * (e.g. `cf_workers_invocations`) and the tags come from the upstream
   * dataset dimensions rather than the running worker's request context.
   */
  pushRaw(metric: Metric) {
    for (const provider of this.metricsProviders) {
      provider.pushMetric(metric);
    }
  }
}
