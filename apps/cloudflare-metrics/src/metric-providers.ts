import { Point } from '@influxdata/influxdb-client';
import {
  type LastFlushStats,
  MAX_PENDING_FLUSH_BYTES,
  pendingFlushBuffers,
  recordLastFlushStats,
} from './flush-state.js';
import { Metric } from './metric.js';

export interface IMetricsProviderRepository {
  pushMetric(metric: Metric): void;
  flush(): void | Promise<void>;
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

    // Keep stashed retries separate until the POST succeeds so the
    // eviction loop can drop oldest-first when the byte cap is crossed.
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
      // No token (local/dev): treat as successful for cleanup.
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
    const stats: LastFlushStats = {
      bytes: body.length,
      durationMs,
      status,
      pendingBuffers: pendingFlushBuffers.length,
      pendingBytes: pendingFlushBuffers.reduce((acc, b) => acc + b.length, 0),
    };
    recordLastFlushStats(stats);
  }

  private stashFailedFlush(body: string): void {
    pendingFlushBuffers.push(body);
    let total = pendingFlushBuffers.reduce((acc, b) => acc + b.length, 0);
    while (total > MAX_PENDING_FLUSH_BYTES && pendingFlushBuffers.length > 1) {
      const dropped = pendingFlushBuffers.shift();
      total -= dropped?.length ?? 0;
      console.warn('[metrics] dropped buffered flush body over cap');
    }
  }
}
