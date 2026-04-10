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
    const currentBody = this.metrics.join('\n');
    this.metrics = [];

    // Prepend any buffered bodies from previous failed flushes (oldest first).
    const parts = [...pendingFlushBuffers];
    if (currentBody) {
      parts.push(currentBody);
    }
    pendingFlushBuffers.length = 0;

    if (parts.length === 0) {
      return;
    }
    const body = parts.join('\n');

    if (this.environment !== 'prod') {
      console.log(body);
    }
    if (!this.influxApiToken) {
      return;
    }
    try {
      const response = await fetch(this.writeUrl, {
        method: 'POST',
        body,
        headers: { Authorization: `Token ${this.influxApiToken}` },
      });
      await response.body?.cancel();
      if (!response.ok) {
        console.error('Failed to push metrics', response.status, response.statusText);
        this.stashFailedFlush(body);
      }
    } catch (error) {
      console.error('Metric flush threw', error);
      this.stashFailedFlush(body);
    }
  }

  private stashFailedFlush(body: string): void {
    // Evict oldest buffers if we're over the byte cap.
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
