import { beforeEach, describe, expect, it } from 'vitest';
import { __resetFlushStateForTests } from './flush-state.js';
import { InfluxMetricsProvider } from './metric-providers.js';
import { Metric } from './metric.js';

function getLines(provider: InfluxMetricsProvider): string[] {
  return (provider as unknown as { metrics: string[] }).metrics;
}

describe('InfluxDB line protocol escaping', () => {
  beforeEach(() => {
    __resetFlushStateForTests();
  });

  it('escapes commas in measurement names', () => {
    const provider = new InfluxMetricsProvider('', '');
    const metric = Metric.create('my,measurement').intField('v', 1);
    provider.pushMetric(metric);
    const [line] = getLines(provider);
    expect(line).toMatch(/^my\\,measurement /);
  });

  it('escapes spaces in measurement names', () => {
    const provider = new InfluxMetricsProvider('', '');
    const metric = Metric.create('my measurement').intField('v', 1);
    provider.pushMetric(metric);
    const [line] = getLines(provider);
    expect(line).toMatch(/^my\\ measurement /);
  });

  it('escapes commas, equals, and spaces in tag keys', () => {
    const provider = new InfluxMetricsProvider('', '');
    const metric = Metric.create('test').addTag('k,e=y s', 'val').intField('v', 1);
    provider.pushMetric(metric);
    const [line] = getLines(provider);
    expect(line).toContain(String.raw`k\,e\=y\ s=val`);
  });

  it('escapes commas, equals, and spaces in tag values', () => {
    const provider = new InfluxMetricsProvider('', '');
    const metric = Metric.create('test').addTag('key', 'a,b=c d').intField('v', 1);
    provider.pushMetric(metric);
    const [line] = getLines(provider);
    expect(line).toContain(String.raw`key=a\,b\=c\ d`);
  });

  it('escapes commas, equals, and spaces in field keys', () => {
    const provider = new InfluxMetricsProvider('', '');
    const metric = Metric.create('test').intField('f,i=e d', 42);
    provider.pushMetric(metric);
    const [line] = getLines(provider);
    expect(line).toContain(String.raw`f\,i\=e\ d=42i`);
  });

  it('handles measurement names with no special characters', () => {
    const provider = new InfluxMetricsProvider('', '');
    const metric = Metric.create('simple_metric').intField('v', 1);
    provider.pushMetric(metric);
    const [line] = getLines(provider);
    expect(line).toMatch(/^simple_metric /);
  });
});

describe('InfluxDB line protocol NaN/Infinity handling', () => {
  beforeEach(() => {
    __resetFlushStateForTests();
  });

  it('skips NaN float fields', () => {
    const provider = new InfluxMetricsProvider('', '');
    const metric = Metric.create('test').floatField('bad', Number.NaN).intField('good', 1);
    provider.pushMetric(metric);
    const [line] = getLines(provider);
    expect(line).not.toContain('bad');
    expect(line).toContain('good=1i');
  });

  it('skips Infinity float fields', () => {
    const provider = new InfluxMetricsProvider('', '');
    const metric = Metric.create('test').floatField('bad', Infinity).intField('good', 1);
    provider.pushMetric(metric);
    const [line] = getLines(provider);
    expect(line).not.toContain('bad');
    expect(line).toContain('good=1i');
  });

  it('skips -Infinity int fields', () => {
    const provider = new InfluxMetricsProvider('', '');
    const metric = Metric.create('test').intField('bad', -Infinity).intField('good', 2);
    provider.pushMetric(metric);
    const [line] = getLines(provider);
    expect(line).not.toContain('bad');
    expect(line).toContain('good=2i');
  });

  it('drops the entire line when all fields are NaN/Infinity', () => {
    const provider = new InfluxMetricsProvider('', '');
    const metric = Metric.create('test').floatField('a', Number.NaN).floatField('b', Infinity);
    provider.pushMetric(metric);
    expect(getLines(provider)).toHaveLength(0);
  });

  it('keeps zero and negative values', () => {
    const provider = new InfluxMetricsProvider('', '');
    const metric = Metric.create('test').intField('zero', 0).intField('neg', -5).floatField('frac', 0);
    provider.pushMetric(metric);
    const [line] = getLines(provider);
    expect(line).toContain('zero=0i');
    expect(line).toContain('neg=-5i');
    expect(line).toContain('frac=0');
  });
});

describe('InfluxDB line protocol timestamp', () => {
  beforeEach(() => {
    __resetFlushStateForTests();
  });

  it('appends nanosecond timestamp when exportTimestamp is set', () => {
    const provider = new InfluxMetricsProvider('', '');
    const ts = new Date('2026-04-10T12:00:00Z');
    const metric = Metric.create('test').intField('v', 1).setExportTimestamp(ts);
    provider.pushMetric(metric);
    const [line] = getLines(provider);
    const expectedNs = ts.getTime() * 1_000_000;
    expect(line.endsWith(` ${expectedNs}`)).toBe(true);
  });

  it('omits timestamp when exportTimestamp is not set', () => {
    const provider = new InfluxMetricsProvider('', '');
    const metric = Metric.create('test').intField('v', 1);
    provider.pushMetric(metric);
    const [line] = getLines(provider);
    // Line should end with a field value, not a timestamp
    expect(line).toMatch(/v=1i$/);
  });
});

describe('getMetricsWriteUrl', () => {
  it('uses prod URL for prod environment', () => {
    const provider = new InfluxMetricsProvider('token', 'prod');
    const url = (provider as unknown as { writeUrl: string }).writeUrl;
    expect(url).toBe('https://cf-workers.monitoring.immich.cloud/write');
  });

  it('uses dev URL for empty environment', () => {
    const provider = new InfluxMetricsProvider('token', '');
    const url = (provider as unknown as { writeUrl: string }).writeUrl;
    expect(url).toBe('https://cf-workers.monitoring.dev.immich.cloud/write');
  });

  it('uses staging URL for staging environment', () => {
    const provider = new InfluxMetricsProvider('token', 'staging');
    const url = (provider as unknown as { writeUrl: string }).writeUrl;
    expect(url).toBe('https://cf-workers.monitoring.staging.immich.cloud/write');
  });
});
