import { Point } from '@influxdata/influxdb-client';
import { type AsyncFn, type MonitorOptions, type Operation, monitorAsyncFunction } from './monitor.js';

export class Metric {
  private _tags = new Map<string, string>();
  private _timestamp = performance.now();
  private _fields = new Map<string, { value: number; type: 'duration' | 'int' }>();
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
    for (const [key, { value }] of metric.fields) {
      point.intField(key, value);
    }
    const line = point.toLineProtocol()?.toString();
    if (line) {
      this.metrics.push(line);
    }
  }

  async flush() {
    if (this.metrics.length === 0) {
      return;
    }
    const body = this.metrics.join('\n');
    if (this.environment !== 'prod') {
      console.log(body);
    }
    if (!this.influxApiToken) {
      return;
    }
    const response = await fetch(this.writeUrl, {
      method: 'POST',
      body,
      headers: { Authorization: `Token ${this.influxApiToken}` },
    });
    if (!response.ok) {
      console.error('Failed to push metrics', response.status, response.statusText);
    }
    await response.body?.cancel();
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
}
