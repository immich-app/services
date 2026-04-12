import { Point } from '@influxdata/influxdb-client';
import {
  type LastFlushStats,
  MAX_PENDING_FLUSH_BYTES,
  pendingFlushBuffers,
  recordLastFlushStats,
} from './flush-state.js';
import { Metric } from './metric.js';

/**
 * Interface implemented by every metric sink the repository can write to.
 * Each cron tick fans out to every registered provider, then `flush()` is
 * called once to drain any buffered data.
 */
export interface IMetricsProviderRepository {
  pushMetric(metric: Metric): void;
  flush(): void | Promise<void>;
}

/**
 * In-memory provider that converts duration fields into a single
 * `Server-Timing` header string. Used by the HTTP handler so request
 * timings show up in browser dev tools alongside normal metrics.
 */
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
 * VictoriaMetrics-backed provider. Collects pushed metrics into an
 * in-memory line-protocol buffer, POSTs the whole buffer once per flush,
 * and persists failed bodies across cron ticks via the module-level
 * `pendingFlushBuffers` state so a transient outage doesn't drop data.
 *
 * Flushes are observed from the NEXT cron tick via `takeLastFlushStats()`
 * — it's impossible to emit a metric about a flush from inside the flush
 * itself, so the stats land in `flush-state.ts` and the scheduled
 * handler picks them up on its way in.
 */
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
