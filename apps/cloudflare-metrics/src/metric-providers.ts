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
    // Header metrics are consumed via getTimingHeader(); nothing to log.
  }
}

// InfluxDB line protocol escape rules. Keep these simple — we do a cheap
// `includes` check first and only fall into the replace when needed.
// Measurement: escape `,` and ` `.
// Tag key / tag value / field key: escape `,`, `=`, ` `.
function escapeMeasurement(s: string): string {
  if (!s.includes(',') && !s.includes(' ')) {
    return s;
  }
  return s.replaceAll(',', String.raw`\,`).replaceAll(' ', String.raw`\ `);
}

function escapeTagKey(s: string): string {
  if (!s.includes(',') && !s.includes('=') && !s.includes(' ')) {
    return s;
  }
  return s
    .replaceAll(',', String.raw`\,`)
    .replaceAll('=', String.raw`\=`)
    .replaceAll(' ', String.raw`\ `);
}

function escapeTagValue(s: string): string {
  if (!s.includes(',') && !s.includes('=') && !s.includes(' ')) {
    return s;
  }
  return s
    .replaceAll(',', String.raw`\,`)
    .replaceAll('=', String.raw`\=`)
    .replaceAll(' ', String.raw`\ `);
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
    // Build InfluxDB line protocol directly to avoid the overhead of the
    // Point class (validation, type coercion, repeated escaping passes) on
    // the hot path. Our inputs are already well-formed — no string fields,
    // no nulls, no duplicate keys.
    let line = escapeMeasurement(metric.name);
    for (const [key, value] of metric.tags) {
      line += ',' + escapeTagKey(key) + '=' + escapeTagValue(value);
    }
    let fieldPart = '';
    for (const [key, { value, type }] of metric.fields) {
      if (fieldPart) {
        fieldPart += ',';
      }
      // int/duration → write as integer with `i` suffix
      const serialized = type === 'float' ? value.toString() : Math.round(value).toString() + 'i';
      fieldPart += escapeTagKey(key) + '=' + serialized;
    }
    if (!fieldPart) {
      return; // no fields → skip
    }
    line += ' ' + fieldPart;
    const exportTimestamp = metric.exportTimestamp;
    if (exportTimestamp) {
      // Line protocol uses nanosecond precision
      line += ' ' + (exportTimestamp.getTime() * 1_000_000).toString();
    }
    this.metrics.push(line);
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

    // Non-prod body logging removed — payloads of ~3000 lines per tick
    // blow the 256KB log budget and waste CPU on string serialization.
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
