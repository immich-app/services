import { beforeEach, describe, expect, it } from 'vitest';
import { __resetFlushStateForTests, takeLastFlushStats } from './flush-state.js';
import { InfluxMetricsProvider, type IMetricsProviderRepository } from './metric-providers.js';
import { Metric } from './metric.js';
import { CloudflareMetricsRepository } from './metrics.js';

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

describe('CloudflareMetricsRepository', () => {
  class Recorder implements IMetricsProviderRepository {
    public readonly pushed: Metric[] = [];
    pushMetric(metric: Metric) {
      this.pushed.push(metric);
    }
    flush() {
      /* noop */
    }
  }

  it('prefixes `push()` metrics with the operation prefix and merges default tags', () => {
    const provider = new Recorder();
    const repo = new CloudflareMetricsRepository('svc', new Request('https://localhost/test'), [provider], 'test-env');
    repo.push(Metric.create('event').addTag('kind', 'foo').intField('count', 1));
    const [metric] = provider.pushed;
    expect(metric.name).toBe('svc_event');
    expect(metric.tags.get('kind')).toBe('foo');
    expect(metric.tags.get('environment')).toBe('test-env');
  });

  it('forwards `pushRaw()` metrics untouched (no prefix, no default tags)', () => {
    const provider = new Recorder();
    const repo = new CloudflareMetricsRepository('svc', new Request('https://localhost/test'), [provider], 'test-env');
    repo.pushRaw(Metric.create('cf_event').addTag('kind', 'foo').intField('count', 1));
    const [metric] = provider.pushed;
    expect(metric.name).toBe('cf_event');
    expect(metric.tags.get('environment')).toBeUndefined();
  });
});

describe('InfluxMetricsProvider flush self-telemetry', () => {
  beforeEach(() => {
    __resetFlushStateForTests();
  });

  it('takeLastFlushStats returns null before any flush has completed', () => {
    expect(takeLastFlushStats()).toBeNull();
  });

  it('records stats with status=ok after a successful flush', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (() => Promise.resolve(new Response('', { status: 204 }))) as typeof fetch;
    try {
      const provider = new InfluxMetricsProvider('token', 'prod');
      provider.pushMetric(Metric.create('foo').intField('v', 1));
      await provider.flush();
      const stats = takeLastFlushStats();
      expect(stats?.status).toBe('ok');
      expect(stats?.bytes).toBeGreaterThan(0);
      expect(stats?.pendingBuffers).toBe(0);
      expect(stats?.pendingBytes).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('records stats with status=error after a failed flush', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (() => Promise.resolve(new Response('bad', { status: 502 }))) as typeof fetch;
    try {
      const provider = new InfluxMetricsProvider('token', 'prod');
      provider.pushMetric(Metric.create('foo').intField('v', 1));
      await provider.flush();
      const stats = takeLastFlushStats();
      expect(stats?.status).toBe('error');
      // The failed body gets stashed in the retry buffer — surface that
      // so the next-tick self-telemetry can show it.
      expect(stats?.pendingBuffers).toBe(1);
      expect(stats?.pendingBytes).toBeGreaterThan(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('clears lastFlushStats after a single take', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (() => Promise.resolve(new Response('', { status: 204 }))) as typeof fetch;
    try {
      const provider = new InfluxMetricsProvider('token', 'prod');
      provider.pushMetric(Metric.create('foo').intField('v', 1));
      await provider.flush();
      expect(takeLastFlushStats()).not.toBeNull();
      expect(takeLastFlushStats()).toBeNull();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('evicts the oldest stashed flush body when the total exceeds the cap', async () => {
    const originalFetch = globalThis.fetch;
    // Always fail so every flush stashes its body in the retry buffer.
    globalThis.fetch = (() => Promise.resolve(new Response('', { status: 502 }))) as typeof fetch;
    try {
      // Each payload is ~400 KB of raw line protocol; three of them land us
      // over the 1 MB cap and force an eviction.
      const padding = 'x'.repeat(400 * 1024);
      const provider = new InfluxMetricsProvider('token', 'prod');

      provider.pushMetric(Metric.create('first').addTag('pad', padding).intField('v', 1));
      await provider.flush();

      provider.pushMetric(Metric.create('second').addTag('pad', padding).intField('v', 2));
      await provider.flush();

      provider.pushMetric(Metric.create('third').addTag('pad', padding).intField('v', 3));
      await provider.flush();

      const stats = takeLastFlushStats();
      // Two buffers should remain — the oldest got dropped to stay under the cap.
      expect(stats?.pendingBuffers).toBe(2);
      expect(stats?.pendingBytes).toBeLessThan(1 * 1024 * 1024 + 400 * 1024);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('InfluxMetricsProvider line protocol', () => {
  beforeEach(() => {
    __resetFlushStateForTests();
  });

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
