import { describe, expect, it } from 'vitest';
import { InfluxMetricsProvider, Metric } from './metrics.js';

describe('Metric', () => {
  it('stores int, float, and duration fields with their types', () => {
    const metric = Metric.create('test')
      .addTag('foo', 'bar')
      .intField('count', 5)
      .floatField('ratio', 0.42)
      .durationField('duration', 12.5);

    expect(metric.name).toBe('test');
    expect(metric.tags.get('foo')).toBe('bar');
    expect(metric.fields.get('count')).toEqual({ value: 5, type: 'int' });
    expect(metric.fields.get('ratio')).toEqual({ value: 0.42, type: 'float' });
    expect(metric.fields.get('duration')).toEqual({ value: 12.5, type: 'duration' });
  });

  it('records an export timestamp override', () => {
    const now = new Date('2026-04-10T12:00:00Z');
    const metric = Metric.create('test').intField('v', 1).setExportTimestamp(now);
    expect(metric.exportTimestamp).toEqual(now);
  });

  it('prefixes metric name only if not already prefixed', () => {
    const metric = Metric.create('op');
    metric.prefixName('svc');
    metric.prefixName('svc');
    expect(metric.name).toBe('svc_op');
  });
});

describe('InfluxMetricsProvider line protocol', () => {
  it('emits int and float fields with the correct suffixes', () => {
    const provider = new InfluxMetricsProvider('', '');
    const metric = Metric.create('cf_test')
      .addTag('script_name', 'hello')
      .intField('requests', 3)
      .floatField('duration_ms', 1.5)
      .setExportTimestamp(new Date('2026-04-10T12:00:00Z'));
    provider.pushMetric(metric);

    // Access the private `metrics` via casting — we just want to assert the line protocol.
    const lines = (provider as unknown as { metrics: string[] }).metrics;
    expect(lines).toHaveLength(1);
    // Integer field should end with `i`, float should not.
    expect(lines[0]).toMatch(/cf_test,script_name=hello .*requests=3i/);
    expect(lines[0]).toMatch(/duration_ms=1\.5/);
    // Timestamp in nanoseconds for 2026-04-10T12:00:00Z
    const expectedNs = new Date('2026-04-10T12:00:00Z').getTime() * 1_000_000;
    expect(lines[0]).toMatch(new RegExp(` ${expectedNs}$`));
  });

  it('flush clears the pending buffer', async () => {
    const provider = new InfluxMetricsProvider('', '');
    provider.pushMetric(Metric.create('foo').intField('v', 1));
    expect(provider.pendingCount).toBe(1);
    await provider.flush();
    expect(provider.pendingCount).toBe(0);
  });

  it('stashes a failed flush body and resends it on the next successful flush', async () => {
    // Use a fetch mock via globalThis so the provider picks it up through its
    // real `fetch` call path.
    const originalFetch = globalThis.fetch;
    let call = 0;
    const received: string[] = [];
    globalThis.fetch = ((_url: RequestInfo | URL, init?: RequestInit) => {
      call++;
      received.push(init?.body as string);
      if (call === 1) {
        // First flush: backend is down.
        return Promise.resolve(new Response('bad gateway', { status: 502 }));
      }
      return Promise.resolve(new Response('', { status: 204 }));
    }) as typeof fetch;

    try {
      const provider = new InfluxMetricsProvider('token', 'prod');
      provider.pushMetric(Metric.create('first').intField('v', 1));
      await provider.flush();
      // First attempt failed; the body should be stashed in the module-level
      // retry buffer.

      provider.pushMetric(Metric.create('second').intField('v', 2));
      await provider.flush();

      expect(call).toBe(2);
      // Second request body should contain BOTH the retried first flush and
      // the newly pushed metric, concatenated.
      expect(received[1]).toContain('first');
      expect(received[1]).toContain('second');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
