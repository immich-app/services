import { beforeEach, describe, expect, it } from 'vitest';
import { buildMetric, normalizeTagValue, resolveTimestamp } from './emit.js';
import { __resetResourceCachesForTests, type ResourceCache } from './resource-cache.js';
import type { DatasetQuery, DatasetRow } from './types.js';

function emptyCache(): ResourceCache {
  return {
    d1Databases: new Map(),
    queues: new Map(),
    zones: new Map(),
    bulkZoneTags: new Set(),
  };
}

const WORKERS_DATASET: DatasetQuery = {
  key: 'workers_invocations',
  measurement: 'cf_workers_invocations',
  field: 'workersInvocationsAdaptive',
  dimensions: ['datetimeMinute', 'scriptName', 'status'],
  topLevelFields: [],
  blocks: { sum: ['requests', 'errors'] },
  tags: [
    { source: 'scriptName', as: 'script_name' },
    { source: 'status', as: 'status' },
  ],
  fields: {
    requests: { type: 'int', source: ['sum', 'requests'] },
    errors: { type: 'int', source: ['sum', 'errors'] },
  },
};

describe('resolveTimestamp', () => {
  it('parses datetimeMinute ISO string', () => {
    const row: DatasetRow = { dimensions: { datetimeMinute: '2026-04-10T12:00:00Z' } };
    const result = resolveTimestamp(WORKERS_DATASET, row);
    expect(result).toEqual(new Date('2026-04-10T12:00:00Z'));
  });

  it('returns null when dimension is missing', () => {
    const row: DatasetRow = { dimensions: {} };
    expect(resolveTimestamp(WORKERS_DATASET, row)).toBeNull();
  });

  it('returns null when dimension value is null', () => {
    const row: DatasetRow = { dimensions: { datetimeMinute: null } };
    expect(resolveTimestamp(WORKERS_DATASET, row)).toBeNull();
  });

  it('returns null for invalid date strings', () => {
    const row: DatasetRow = { dimensions: { datetimeMinute: 'not-a-date' } };
    expect(resolveTimestamp(WORKERS_DATASET, row)).toBeNull();
  });

  it('converts date dimension to UTC midnight', () => {
    const dataset: DatasetQuery = {
      ...WORKERS_DATASET,
      timestampDimension: 'date',
    };
    const row: DatasetRow = { dimensions: { date: '2026-04-10' } };
    const result = resolveTimestamp(dataset, row);
    expect(result).toEqual(new Date('2026-04-10T00:00:00Z'));
  });

  it('coerces non-string values to string', () => {
    const row: DatasetRow = { dimensions: { datetimeMinute: 1_744_272_000_000 as unknown as string } };
    expect(resolveTimestamp(WORKERS_DATASET, row)).toBeNull();
  });
});

describe('normalizeTagValue', () => {
  it('returns string values as-is', () => {
    expect(normalizeTagValue('hello')).toBe('hello');
  });

  it('returns undefined for empty strings', () => {
    expect(normalizeTagValue('')).toBeUndefined();
  });

  it('returns undefined for null', () => {
    expect(normalizeTagValue(null)).toBeUndefined();
  });

  it('returns undefined for undefined', () => {
    expect(normalizeTagValue()).toBeUndefined();
  });

  it('coerces numbers to strings', () => {
    expect(normalizeTagValue(200)).toBe('200');
    expect(normalizeTagValue(0)).toBe('0');
  });

  it('coerces booleans to strings', () => {
    expect(normalizeTagValue(true)).toBe('true');
    expect(normalizeTagValue(false)).toBe('false');
  });

  it('returns undefined for objects', () => {
    expect(normalizeTagValue({})).toBeUndefined();
    expect(normalizeTagValue([])).toBeUndefined();
  });
});

describe('buildMetric', () => {
  beforeEach(() => {
    __resetResourceCachesForTests();
  });

  it('builds a metric with tags and fields from a row', () => {
    const row: DatasetRow = {
      dimensions: { datetimeMinute: '2026-04-10T12:00:00Z', scriptName: 'my-worker', status: 'success' },
      sum: { requests: 10, errors: 0 },
    };
    const metric = buildMetric(WORKERS_DATASET, row, 'acct-1', emptyCache());
    expect(metric).not.toBeNull();
    expect(metric!.name).toBe('cf_workers_invocations');
    expect(metric!.tags.get('account_id')).toBe('acct-1');
    expect(metric!.tags.get('script_name')).toBe('my-worker');
    expect(metric!.tags.get('status')).toBe('success');
    expect(metric!.fields.get('requests')).toEqual({ value: 10, type: 'int' });
    expect(metric!.fields.get('errors')).toEqual({ value: 0, type: 'int' });
    expect(metric!.exportTimestamp).toEqual(new Date('2026-04-10T12:00:00Z'));
  });

  it('returns null when timestamp is missing', () => {
    const row: DatasetRow = { dimensions: {}, sum: { requests: 1 } };
    expect(buildMetric(WORKERS_DATASET, row, 'acct', emptyCache())).toBeNull();
  });

  it('returns null when no numeric fields are present', () => {
    const row: DatasetRow = {
      dimensions: { datetimeMinute: '2026-04-10T12:00:00Z' },
      sum: { requests: null, errors: null },
    };
    expect(buildMetric(WORKERS_DATASET, row, 'acct', emptyCache())).toBeNull();
  });

  it('skips null fields but keeps zero-valued fields', () => {
    const row: DatasetRow = {
      dimensions: { datetimeMinute: '2026-04-10T12:00:00Z', scriptName: 'w', status: 'ok' },
      sum: { requests: 0, errors: null },
    };
    const metric = buildMetric(WORKERS_DATASET, row, 'acct', emptyCache());
    expect(metric).not.toBeNull();
    expect(metric!.fields.has('requests')).toBe(true);
    expect(metric!.fields.has('errors')).toBe(false);
  });

  it('applies float type and scale factor', () => {
    const dataset: DatasetQuery = {
      ...WORKERS_DATASET,
      fields: {
        duration_ms: { type: 'float', source: ['sum', 'duration'], scale: 1000 },
      },
    };
    const row: DatasetRow = {
      dimensions: { datetimeMinute: '2026-04-10T12:00:00Z' },
      sum: { duration: 0.5 },
    };
    const metric = buildMetric(dataset, row, 'acct', emptyCache());
    expect(metric!.fields.get('duration_ms')).toEqual({ value: 500, type: 'float' });
  });

  it('reads top-level fields via _top source', () => {
    const dataset: DatasetQuery = {
      ...WORKERS_DATASET,
      topLevelFields: ['count'],
      fields: {
        total: { type: 'int', source: ['_top', 'count'] },
      },
    };
    const row: DatasetRow = {
      dimensions: { datetimeMinute: '2026-04-10T12:00:00Z' },
      count: 42,
    };
    const metric = buildMetric(dataset, row, 'acct', emptyCache());
    expect(metric!.fields.get('total')).toEqual({ value: 42, type: 'int' });
  });

  it('enriches D1 rows with database_name from cache', () => {
    const dataset: DatasetQuery = {
      key: 'd1_queries',
      measurement: 'cf_d1_queries',
      field: 'd1QueriesAdaptiveGroups',
      dimensions: ['datetimeMinute', 'databaseId'],
      topLevelFields: [],
      blocks: { sum: ['readQueries'] },
      tags: [{ source: 'databaseId', as: 'database_id' }],
      fields: { read_queries: { type: 'int', source: ['sum', 'readQueries'] } },
    };
    const cache = emptyCache();
    cache.d1Databases.set('db-1', 'my-database');
    const row: DatasetRow = {
      dimensions: { datetimeMinute: '2026-04-10T12:00:00Z', databaseId: 'db-1' },
      sum: { readQueries: 5 },
    };
    const metric = buildMetric(dataset, row, 'acct', cache);
    expect(metric!.tags.get('database_name')).toBe('my-database');
  });

  it('enriches queue rows with queue_name from cache', () => {
    const dataset: DatasetQuery = {
      key: 'queue_operations',
      measurement: 'cf_queue_operations',
      field: 'queueMessageOperationsAdaptiveGroups',
      dimensions: ['datetimeMinute', 'queueId'],
      topLevelFields: [],
      blocks: { sum: ['billableOperations'] },
      tags: [{ source: 'queueId', as: 'queue_id' }],
      fields: { billable_operations: { type: 'int', source: ['sum', 'billableOperations'] } },
    };
    const cache = emptyCache();
    cache.queues.set('q-1', 'my-queue');
    const row: DatasetRow = {
      dimensions: { datetimeMinute: '2026-04-10T12:00:00Z', queueId: 'q-1' },
      sum: { billableOperations: 10 },
    };
    const metric = buildMetric(dataset, row, 'acct', cache);
    expect(metric!.tags.get('queue_name')).toBe('my-queue');
  });

  it('enriches HTTP rows with zone_name, falling back to zone tag', () => {
    const dataset: DatasetQuery = {
      key: 'http_requests_overview',
      measurement: 'cf_http_requests_overview',
      field: 'httpRequestsOverviewAdaptiveGroups',
      dimensions: ['datetimeMinute', 'zoneTag'],
      topLevelFields: [],
      blocks: { sum: ['requests'] },
      tags: [{ source: 'zoneTag', as: 'zone_tag' }],
      fields: { requests: { type: 'int', source: ['sum', 'requests'] } },
    };
    const cache = emptyCache();
    const row: DatasetRow = {
      dimensions: { datetimeMinute: '2026-04-10T12:00:00Z', zoneTag: 'zone-xyz' },
      sum: { requests: 1 },
    };
    const metric = buildMetric(dataset, row, 'acct', cache);
    expect(metric!.tags.get('zone_name')).toBe('zone-xyz');
  });

  it('does not apply enrichment for unrecognized dataset fields', () => {
    const dataset: DatasetQuery = {
      ...WORKERS_DATASET,
      field: 'somethingElse',
    };
    const row: DatasetRow = {
      dimensions: { datetimeMinute: '2026-04-10T12:00:00Z', scriptName: 'w', status: 's' },
      sum: { requests: 1, errors: 0 },
    };
    const metric = buildMetric(dataset, row, 'acct', emptyCache());
    expect(metric!.tags.has('database_name')).toBe(false);
    expect(metric!.tags.has('queue_name')).toBe(false);
    expect(metric!.tags.has('zone_name')).toBe(false);
  });
});
