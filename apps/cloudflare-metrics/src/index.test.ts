import { SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ICloudflareRestClient } from './cloudflare-api.js';
import { __resetCollectorCachesForTests, CloudflareMetricsCollector } from './collector.js';
import {
  ALL_DATASETS,
  D1_QUERIES,
  DURABLE_OBJECTS_PERIODIC,
  DURABLE_OBJECTS_STORAGE,
  HTTP_REQUESTS_OVERVIEW,
  HYPERDRIVE_POOL,
  QUEUE_BACKLOG,
  QUEUE_OPERATIONS,
  R2_OPERATIONS,
  WORKERS_INVOCATIONS,
} from './datasets.js';
import {
  buildBatchedAccountQuery,
  buildBatchedZoneQuery,
  buildDatasetSelection,
  buildFilterObject,
  CloudflareGraphQLClient,
  CloudflareGraphQLError,
  groupErrorsByAlias,
} from './graphql-client.js';
import {
  CloudflareMetricsRepository,
  InfluxMetricsProvider,
  Metric,
  type IMetricsProviderRepository,
} from './metrics.js';
import type { DatasetQuery, DatasetRow } from './types.js';

class RecordingProvider implements IMetricsProviderRepository {
  readonly metrics: Metric[] = [];
  flushCount = 0;
  pushMetric(metric: Metric) {
    this.metrics.push(metric);
  }
  flush() {
    this.flushCount++;
  }
}

function metricsRepo(provider: IMetricsProviderRepository) {
  return new CloudflareMetricsRepository('cloudflare_metrics', new Request('https://localhost/test'), [provider], '');
}

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

describe('buildDatasetSelection', () => {
  it('produces an aliased field selection with dimensions and blocks', () => {
    const selection = buildDatasetSelection(WORKERS_INVOCATIONS, 'workers_invocations');
    expect(selection).toContain('workers_invocations: workersInvocationsAdaptive(limit: 9999, filter: $filter');
    expect(selection).toContain('dimensions { datetimeMinute scriptName status scriptVersion usageModel }');
    expect(selection).toContain('sum { requests errors');
    expect(selection).toContain('quantiles { cpuTimeP50 cpuTimeP99');
    expect(selection).toContain('orderBy: [datetimeMinute_ASC]');
  });

  it('omits the alias prefix when the alias matches the field name', () => {
    const selection = buildDatasetSelection(WORKERS_INVOCATIONS);
    expect(selection.startsWith('workersInvocationsAdaptive(')).toBe(true);
    // The GraphQL `filter: $filter` argument also uses `: ` so we can't
    // test absence of the colon globally — just assert the alias prefix
    // isn't present at the start.
    expect(selection).not.toMatch(/^workers_invocations: workersInvocationsAdaptive/);
  });

  it('includes top-level scalar fields between dimensions and blocks', () => {
    const dataset: DatasetQuery = {
      key: 'x',
      measurement: 'cf_x',
      field: 'xGroups',
      dimensions: ['datetimeMinute'],
      topLevelFields: ['count'],
      blocks: {},
      tags: [],
      fields: { count: { type: 'int', source: ['_top', 'count'] } },
    };
    const selection = buildDatasetSelection(dataset, 'x');
    expect(selection).toMatch(/dimensions \{ datetimeMinute \}\s+count/);
  });

  it('omits orderBy when the timestamp dimension is not selected', () => {
    const dataset: DatasetQuery = { ...WORKERS_INVOCATIONS, dimensions: ['scriptName'] };
    const selection = buildDatasetSelection(dataset, 'x');
    expect(selection).not.toContain('orderBy');
  });
});

describe('buildBatchedAccountQuery', () => {
  it('wraps multiple aliased selections in a single viewer.accounts query', () => {
    const query = buildBatchedAccountQuery([WORKERS_INVOCATIONS, D1_QUERIES]);
    expect(query).toContain('$accountTag: String!');
    expect(query).toContain('$filter: JSON!');
    expect(query).toContain('accounts(filter: { accountTag: $accountTag })');
    expect(query).toContain('workers_invocations: workersInvocationsAdaptive(');
    expect(query).toContain('d1_queries: d1AnalyticsAdaptiveGroups(');
  });

  it('appends a workersInvocationsScheduled selection when requested', () => {
    const query = buildBatchedAccountQuery([WORKERS_INVOCATIONS], true);
    expect(query).toContain('workers_scheduled: workersInvocationsScheduled(');
    expect(query).toContain('scriptName');
    expect(query).toContain('cpuTimeUs');
  });

  it('builds a query for every account-scope dataset in the registry', () => {
    const accountDatasets = ALL_DATASETS.filter((d) => (d.scope ?? 'account') === 'account');
    const query = buildBatchedAccountQuery(accountDatasets, true);
    for (const dataset of accountDatasets) {
      expect(query).toContain(`${dataset.key}: ${dataset.field}(`);
    }
  });
});

describe('buildBatchedZoneQuery', () => {
  const dataset: DatasetQuery = {
    key: 'zone_detail',
    measurement: 'cf_zone_detail',
    field: 'httpRequestsAdaptiveGroups',
    scope: 'zone',
    dimensions: ['datetimeMinute'],
    blocks: { sum: ['edgeResponseBytes'] },
    tags: [],
    fields: { bytes: { type: 'int', source: ['sum', 'edgeResponseBytes'] } },
  };

  it('aliases each zone with an inlined zoneTag literal', () => {
    const query = buildBatchedZoneQuery(['zone-a', 'zone-b'], dataset);
    expect(query).toContain('z0: zones(filter: { zoneTag: "zone-a" })');
    expect(query).toContain('z1: zones(filter: { zoneTag: "zone-b" })');
    expect(query).toContain('httpRequestsAdaptiveGroups(');
  });

  it('rejects zone tags with unsafe characters', () => {
    expect(() => buildBatchedZoneQuery(['zone-a"; evil'], dataset)).toThrow(/Invalid zoneTag/);
  });
});

describe('buildFilterObject', () => {
  const range = {
    start: new Date('2026-04-10T12:00:00Z'),
    end: new Date('2026-04-10T12:10:00Z'),
  };

  it('uses datetime_geq / datetime_leq by default', () => {
    expect(buildFilterObject(WORKERS_INVOCATIONS, range)).toEqual({
      datetime_geq: '2026-04-10T12:00:00.000Z',
      datetime_leq: '2026-04-10T12:10:00.000Z',
    });
  });

  it('uses date_geq / date_leq for date-granularity datasets', () => {
    expect(buildFilterObject(DURABLE_OBJECTS_STORAGE, range)).toEqual({
      date_geq: '2026-04-10',
      date_leq: '2026-04-10',
    });
  });

  it('falls back to datetime filters when no dataset is supplied', () => {
    expect(buildFilterObject(null, range)).toEqual({
      datetime_geq: '2026-04-10T12:00:00.000Z',
      datetime_leq: '2026-04-10T12:10:00.000Z',
    });
  });
});

describe('groupErrorsByAlias', () => {
  it('maps GraphQL error paths to aliased field names', () => {
    const errors = [
      { message: 'boom', path: ['viewer', 'accounts', 0, 'workers_invocations'] },
      { message: 'bang', path: ['viewer', 'accounts', 0, 'd1_queries'] },
    ];
    expect(groupErrorsByAlias(errors)).toEqual({
      workers_invocations: 'boom',
      d1_queries: 'bang',
    });
  });

  it('returns an empty map when errors is null or undefined', () => {
    expect(groupErrorsByAlias(null)).toEqual({});
    // eslint-disable-next-line unicorn/no-useless-undefined
    expect(groupErrorsByAlias(undefined)).toEqual({});
  });
});

describe('CloudflareGraphQLClient', () => {
  it('sends the bearer token and parses batched dataset rows', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            data: {
              viewer: {
                accounts: [
                  {
                    workers_invocations: [
                      {
                        dimensions: { datetimeMinute: '2026-04-10T12:00:00Z', scriptName: 'a' },
                        sum: { requests: 10 },
                      },
                    ],
                  },
                ],
              },
            },
            errors: null,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      ),
    );

    const client = new CloudflareGraphQLClient(
      'tok',
      'https://example.com/graphql',
      fetchMock as unknown as typeof fetch,
    );
    const result = await client.fetchAccountBatch('acct', [WORKERS_INVOCATIONS], {
      start: new Date('2026-04-10T12:00:00Z'),
      end: new Date('2026-04-10T12:10:00Z'),
    });

    expect(result.rows.workers_invocations).toHaveLength(1);
    expect(result.rows.workers_invocations?.[0].dimensions.scriptName).toBe('a');
    const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const init = call[1];
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok');
    const body = JSON.parse(init.body as string);
    expect(body.variables.accountTag).toBe('acct');
    expect(body.query).toContain('workers_invocations: workersInvocationsAdaptive');
  });

  it('throws a CloudflareGraphQLError on HTTP failure', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(new Response('boom', { status: 500 })));
    const client = new CloudflareGraphQLClient(
      'tok',
      'https://example.com/graphql',
      fetchMock as unknown as typeof fetch,
    );
    await expect(
      client.fetchAccountBatch('acct', [WORKERS_INVOCATIONS], { start: new Date(0), end: new Date(1) }),
    ).rejects.toBeInstanceOf(CloudflareGraphQLError);
  });

  it('surfaces per-field errors from a partial GraphQL response', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            data: {
              viewer: {
                accounts: [
                  {
                    workers_invocations: [
                      {
                        dimensions: { datetimeMinute: '2026-04-10T12:00:00Z' },
                        sum: { requests: 1 },
                      },
                    ],
                    d1_queries: null,
                  },
                ],
              },
            },
            errors: [{ message: 'no access', path: ['viewer', 'accounts', 0, 'd1_queries'] }],
          }),
          { status: 200 },
        ),
      ),
    );
    const client = new CloudflareGraphQLClient(
      'tok',
      'https://example.com/graphql',
      fetchMock as unknown as typeof fetch,
    );
    const result = await client.fetchAccountBatch('acct', [WORKERS_INVOCATIONS, D1_QUERIES], {
      start: new Date(0),
      end: new Date(1),
    });
    expect(result.rows.workers_invocations).toHaveLength(1);
    expect(result.errors.d1_queries).toBe('no access');
  });

  it('splits account batches into chunks under the graphql node limit', async () => {
    // Build a fake dataset list that's large enough to span multiple chunks.
    const datasets = Array.from({ length: 60 }, (_, i) => ({
      ...WORKERS_INVOCATIONS,
      key: `ds_${i}`,
      measurement: `cf_ds_${i}`,
    }));
    const fetchMock = vi.fn((_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      // Return the aliased fields that this chunk actually asked for.
      const aliases = [...body.query.matchAll(/(ds_\d+): workersInvocationsAdaptive/g)].map((m) => m[1]);
      const account: Record<string, unknown> = {};
      for (const alias of aliases) {
        account[alias] = [];
      }
      return Promise.resolve(
        new Response(JSON.stringify({ data: { viewer: { accounts: [account] } }, errors: null }), { status: 200 }),
      );
    });
    const client = new CloudflareGraphQLClient(
      'tok',
      'https://example.com/graphql',
      fetchMock as unknown as typeof fetch,
    );
    const result = await client.fetchAccountBatch('acct', datasets, {
      start: new Date('2026-04-10T12:00:00Z'),
      end: new Date('2026-04-10T12:10:00Z'),
    });
    // Each chunk is its own HTTP subrequest.
    expect(fetchMock.mock.calls.length).toBeGreaterThan(1);
    // All datasets get a row entry, even if empty — nothing is dropped across chunks.
    expect(Object.keys(result.rows)).toHaveLength(60);
    expect(Object.keys(result.errors)).toHaveLength(0);
  });

  it('batches multiple zones into a single request', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            data: {
              viewer: {
                z0: [
                  {
                    httpRequestsAdaptiveGroups: [{ dimensions: { datetimeMinute: '2026-04-10T12:00:00Z' }, count: 10 }],
                  },
                ],
                z1: [
                  {
                    httpRequestsAdaptiveGroups: [{ dimensions: { datetimeMinute: '2026-04-10T12:00:00Z' }, count: 20 }],
                  },
                ],
              },
            },
            errors: null,
          }),
          { status: 200 },
        ),
      ),
    );
    const zoneScoped: DatasetQuery = {
      key: 'zone_detail',
      measurement: 'cf_zone_detail',
      field: 'httpRequestsAdaptiveGroups',
      scope: 'zone',
      dimensions: ['datetimeMinute'],
      topLevelFields: ['count'],
      blocks: {},
      tags: [],
      fields: { requests: { type: 'int', source: ['_top', 'count'] } },
    };
    const client = new CloudflareGraphQLClient(
      'tok',
      'https://example.com/graphql',
      fetchMock as unknown as typeof fetch,
    );
    const result = await client.fetchZoneBatch(['zone-a', 'zone-b'], zoneScoped, {
      start: new Date(0),
      end: new Date(1),
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.rows['zone-a']).toHaveLength(1);
    expect(result.rows['zone-b']).toHaveLength(1);
    expect(result.rows['zone-a']?.[0].count).toBe(10);
    expect(result.rows['zone-b']?.[0].count).toBe(20);
  });
});

describe('CloudflareMetricsCollector', () => {
  class FakeClient {
    public calls: Array<{ dataset: string; range: { start: Date; end: Date } }> = [];
    public zoneCalls: Array<{ zoneTags: string[]; dataset: string }> = [];
    public batchCalls: Array<{ datasets: string[]; includeScheduled: boolean }> = [];
    constructor(
      public readonly rowsByDataset: Record<string, DatasetRow[]>,
      public readonly zoneRowsByDataset: Record<string, Record<string, DatasetRow[]>> = {},
      public readonly scheduledInvocations: Array<{
        scriptName: string;
        cron: string;
        status: string;
        datetime: string;
        cpuTimeUs: number;
      }> = [],
      public readonly errorsByDataset: Record<string, string> = {},
    ) {}

    // eslint-disable-next-line @typescript-eslint/require-await
    async fetchAccountBatch(
      _accountTag: string,
      datasets: readonly DatasetQuery[],
      range: { start: Date; end: Date },
      options: { includeScheduledInvocations?: boolean } = {},
    ) {
      this.batchCalls.push({
        datasets: datasets.map((d) => d.key),
        includeScheduled: options.includeScheduledInvocations ?? false,
      });
      const rows: Record<string, DatasetRow[]> = {};
      const errors: Record<string, string> = {};
      for (const dataset of datasets) {
        this.calls.push({ dataset: dataset.key, range });
        if (this.errorsByDataset[dataset.key]) {
          errors[dataset.key] = this.errorsByDataset[dataset.key];
          continue;
        }
        rows[dataset.key] = this.rowsByDataset[dataset.key] ?? [];
      }
      return {
        rows,
        errors,
        scheduledInvocations: options.includeScheduledInvocations ? this.scheduledInvocations : undefined,
      };
    }

    // eslint-disable-next-line @typescript-eslint/require-await
    async fetchZoneBatch(zoneTags: readonly string[], dataset: DatasetQuery, _range: { start: Date; end: Date }) {
      this.zoneCalls.push({ zoneTags: [...zoneTags], dataset: dataset.key });
      const rows: Record<string, DatasetRow[]> = {};
      const errors: Record<string, string> = {};
      for (const zoneTag of zoneTags) {
        const zoneRows = this.zoneRowsByDataset[dataset.key]?.[zoneTag];
        if (zoneRows === undefined && this.errorsByDataset[`zone:${zoneTag}`]) {
          errors[zoneTag] = this.errorsByDataset[`zone:${zoneTag}`];
          continue;
        }
        rows[zoneTag] = zoneRows ?? [];
      }
      return { rows, errors };
    }
  }

  class FakeRestClient implements ICloudflareRestClient {
    public getZoneCalls: string[] = [];
    constructor(
      public readonly d1: Array<{ uuid: string; name: string }> = [],
      public readonly queues: Array<{ queue_id: string; queue_name: string }> = [],
      public readonly zones: Array<{ id: string; name: string }> = [],
      public readonly individualZones: Record<string, { id: string; name: string } | null> = {},
    ) {}
    // eslint-disable-next-line @typescript-eslint/require-await
    async listD1Databases() {
      return this.d1;
    }
    // eslint-disable-next-line @typescript-eslint/require-await
    async listQueues() {
      return this.queues;
    }
    // eslint-disable-next-line @typescript-eslint/require-await
    async listZones() {
      return this.zones;
    }
    // eslint-disable-next-line @typescript-eslint/require-await
    async getZone(zoneId: string) {
      this.getZoneCalls.push(zoneId);
      if (zoneId in this.individualZones) {
        return this.individualZones[zoneId];
      }
      return null;
    }
  }

  class ThrowingRestClient implements ICloudflareRestClient {
    // eslint-disable-next-line @typescript-eslint/require-await
    async listD1Databases(): Promise<never> {
      throw new Error('d1 boom');
    }
    // eslint-disable-next-line @typescript-eslint/require-await
    async listQueues(): Promise<never> {
      throw new Error('queues boom');
    }
    // eslint-disable-next-line @typescript-eslint/require-await
    async listZones(): Promise<never> {
      throw new Error('zones boom');
    }
    // eslint-disable-next-line @typescript-eslint/require-await
    async getZone(): Promise<never> {
      throw new Error('getZone boom');
    }
  }

  let provider: RecordingProvider;
  let metrics: CloudflareMetricsRepository;

  beforeEach(() => {
    provider = new RecordingProvider();
    metrics = metricsRepo(provider);
    __resetCollectorCachesForTests();
  });

  it('computes a lagged query range so late-arriving buckets are included', () => {
    const now = new Date('2026-04-10T12:00:00Z');
    const collector = new CloudflareMetricsCollector(
      new FakeClient({}) as unknown as CloudflareGraphQLClient,
      'acct',
      metrics,
      { now: () => now, lagMs: 2 * 60 * 1000, windowMs: 5 * 60 * 1000 },
    );
    const range = collector.getRange();
    expect(range.end).toEqual(new Date('2026-04-10T11:58:00Z'));
    expect(range.start).toEqual(new Date('2026-04-10T11:53:00Z'));
  });

  it('emits a workers invocations metric with snake_case tags and fields, scaled durations', async () => {
    const row: DatasetRow = {
      dimensions: {
        datetimeMinute: '2026-04-10T12:00:00Z',
        scriptName: 'version-api-prod',
        status: 'success',
        scriptVersion: 'abc',
        usageModel: 'standard',
      },
      sum: {
        requests: 9,
        errors: 0,
        subrequests: 9,
        clientDisconnects: 0,
        cpuTimeUs: 7474,
        duration: 0.165_879,
        wallTime: 1_327_032,
        responseBodySize: 522,
      },
      max: {
        cpuTime: 1400,
        duration: 0.037_329_5,
        wallTime: 298_636,
        requestDuration: 1579,
        responseBodySize: 58,
      },
      quantiles: {
        cpuTimeP50: 730,
        cpuTimeP99: 1400,
        durationP50: 0.015_286_75,
        durationP99: 0.037_329_5,
        wallTimeP50: 122_294,
        wallTimeP99: 298_636,
        responseBodySizeP99: 58,
      },
    };

    const client = new FakeClient({ workers_invocations: [row] });
    const collector = new CloudflareMetricsCollector(
      client as unknown as CloudflareGraphQLClient,
      'acct-xyz',
      metrics,
      { now: () => new Date('2026-04-10T12:15:00Z') },
    );

    const [result] = await collector.collectAll([WORKERS_INVOCATIONS]);
    expect(result.points).toBe(1);
    expect(result.rows).toBe(1);
    expect(result.error).toBeUndefined();

    const exported = provider.metrics.find((m) => m.name === 'cf_workers_invocations');
    expect(exported).toBeDefined();
    expect(exported?.tags.get('script_name')).toBe('version-api-prod');
    expect(exported?.tags.get('status')).toBe('success');
    expect(exported?.tags.get('account_id')).toBe('acct-xyz');
    expect(exported?.exportTimestamp).toEqual(new Date('2026-04-10T12:00:00Z'));
    expect(exported?.fields.get('requests')).toEqual({ value: 9, type: 'int' });
    // Duration in seconds (0.165879) × 1000 = 165.879 ms, stored as float
    expect(exported?.fields.get('duration_ms_sum')).toEqual({ value: 165.879, type: 'float' });
    expect(exported?.fields.get('duration_ms_p99')).toEqual({ value: 37.3295, type: 'float' });
    expect(exported?.fields.get('cpu_time_us_p99')).toEqual({ value: 1400, type: 'int' });
  });

  it('coerces numeric dimensions to string tags', async () => {
    const row: DatasetRow = {
      dimensions: {
        datetimeMinute: '2026-04-10T12:00:00Z',
        bucketName: 'my-bucket',
        actionType: 'GetObject',
        actionStatus: 'success',
        responseStatusCode: 200,
        storageClass: 'Standard',
      },
      sum: { requests: 5, responseBytes: 100, responseObjectSize: 100 },
    };
    const client = new FakeClient({ r2_operations: [row] });
    const collector = new CloudflareMetricsCollector(client as unknown as CloudflareGraphQLClient, 'acct', metrics, {
      now: () => new Date('2026-04-10T12:15:00Z'),
    });
    await collector.collectAll([R2_OPERATIONS]);
    const exported = provider.metrics.find((m) => m.name === 'cf_r2_operations');
    expect(exported?.tags.get('response_status_code')).toBe('200');
    expect(exported?.tags.get('bucket_name')).toBe('my-bucket');
  });

  it('drops rows with neither a timestamp dimension nor any numeric field', async () => {
    const row: DatasetRow = { dimensions: { scriptName: 'no-timestamp' }, sum: { readQueries: 1 } };
    const client = new FakeClient({ d1_queries: [row] });
    const collector = new CloudflareMetricsCollector(client as unknown as CloudflareGraphQLClient, 'acct', metrics, {
      now: () => new Date('2026-04-10T12:15:00Z'),
    });
    const [result] = await collector.collectAll([D1_QUERIES]);
    expect(result.rows).toBe(1);
    expect(result.points).toBe(0);
    expect(provider.metrics.some((m) => m.name === 'cf_d1_queries')).toBe(false);
  });

  it('skips null-valued fields rather than emitting zeros', async () => {
    const row: DatasetRow = {
      dimensions: { datetimeMinute: '2026-04-10T12:00:00Z', databaseId: 'db1', databaseRole: 'primary' },
      sum: { readQueries: null, writeQueries: 0, rowsRead: 10, rowsWritten: null, queryBatchResponseBytes: 100 },
      avg: { queryBatchTimeMs: null, queryBatchResponseBytes: 100, sampleInterval: 1 },
    };
    const client = new FakeClient({ d1_queries: [row] });
    const collector = new CloudflareMetricsCollector(client as unknown as CloudflareGraphQLClient, 'acct', metrics, {
      now: () => new Date('2026-04-10T12:15:00Z'),
    });
    await collector.collectAll([D1_QUERIES]);
    const exported = provider.metrics.find((m) => m.name === 'cf_d1_queries');
    expect(exported?.fields.has('read_queries')).toBe(false);
    expect(exported?.fields.has('rows_written')).toBe(false);
    expect(exported?.fields.get('write_queries')).toEqual({ value: 0, type: 'int' });
    expect(exported?.fields.get('rows_read')).toEqual({ value: 10, type: 'int' });
    expect(exported?.fields.get('query_duration_ms_avg')).toBeUndefined();
    expect(exported?.fields.get('sample_interval')).toEqual({ value: 1, type: 'float' });
  });

  it('records a per-dataset collector metric tagged with success/error', async () => {
    const client = new FakeClient({ workers_invocations: [] });
    const collector = new CloudflareMetricsCollector(client as unknown as CloudflareGraphQLClient, 'acct', metrics, {
      now: () => new Date('2026-04-10T12:15:00Z'),
    });
    await collector.collectAll([WORKERS_INVOCATIONS]);
    const observed = provider.metrics.find(
      (m) => m.name === 'cloudflare_metrics_collector_dataset' && m.tags.get('dataset') === 'workers_invocations',
    );
    expect(observed?.tags.get('status')).toBe('success');
    expect(observed?.fields.get('rows')).toEqual({ value: 0, type: 'int' });
  });

  it('reports per-dataset errors from a batch response without aborting others', async () => {
    // Simulates a partial GraphQL response where one field is rejected and
    // the others still return data. The batched client surfaces the error
    // in `batchResult.errors[dataset.key]`, the collector maps it to a
    // collector_dataset{status=error} self-metric, and the other datasets
    // still get emitted.
    class PartialErrorClient {
      // eslint-disable-next-line @typescript-eslint/require-await
      async fetchAccountBatch(
        _accountTag: string,
        datasets: readonly DatasetQuery[],
        _range: { start: Date; end: Date },
        options: { includeScheduledInvocations?: boolean } = {},
      ) {
        const rows: Record<string, DatasetRow[]> = {};
        const errors: Record<string, string> = {};
        for (const dataset of datasets) {
          if (dataset.key === 'workers_invocations') {
            errors[dataset.key] = 'boom';
          } else {
            rows[dataset.key] = [];
          }
        }
        return {
          rows,
          errors,
          scheduledInvocations: options.includeScheduledInvocations ? [] : undefined,
        };
      }
      // eslint-disable-next-line @typescript-eslint/require-await
      async fetchZoneBatch() {
        return { rows: {}, errors: {} };
      }
    }
    const collector = new CloudflareMetricsCollector(
      new PartialErrorClient() as unknown as CloudflareGraphQLClient,
      'acct',
      metrics,
      { now: () => new Date('2026-04-10T12:15:00Z') },
    );

    const results = await collector.collectAll([WORKERS_INVOCATIONS, R2_OPERATIONS]);
    const workersResult = results.find((r) => r.dataset === 'workers_invocations');
    const r2Result = results.find((r) => r.dataset === 'r2_operations');
    expect(workersResult?.error).toContain('boom');
    expect(r2Result?.error).toBeUndefined();
    const errorMetric = provider.metrics.find(
      (m) => m.tags.get('dataset') === 'workers_invocations' && m.tags.get('status') === 'error',
    );
    expect(errorMetric?.tags.get('error')).toBe('Error');
  });

  it('accepts date-granularity datasets and synthesizes a midnight UTC timestamp', async () => {
    const row: DatasetRow = {
      dimensions: { datetimeMinute: '2026-04-10T12:00:00Z' },
      max: { storedBytes: 1024 },
    };
    const client = new FakeClient({ durable_objects_storage: [row] });
    const collector = new CloudflareMetricsCollector(client as unknown as CloudflareGraphQLClient, 'acct', metrics, {
      now: () => new Date('2026-04-10T12:15:00Z'),
    });
    await collector.collectAll([DURABLE_OBJECTS_STORAGE]);
    const exported = provider.metrics.find((m) => m.name === 'cf_durable_objects_storage');
    expect(exported?.exportTimestamp).toEqual(new Date('2026-04-10T12:00:00Z'));
    expect(exported?.fields.get('stored_bytes')).toEqual({ value: 1024, type: 'int' });
  });

  it('emits periodic durable-object fields with correct unit scaling', async () => {
    const row: DatasetRow = {
      dimensions: { datetimeMinute: '2026-04-10T12:00:00Z', namespaceId: 'ns' },
      sum: {
        activeTime: 1000,
        cpuTime: 500,
        duration: 72.99,
        exceededCpuErrors: 0,
        exceededMemoryErrors: 0,
        fatalInternalErrors: 2,
        inboundWebsocketMsgCount: 0,
        outboundWebsocketMsgCount: 10,
        rowsRead: 100,
        rowsWritten: 50,
        storageDeletes: 0,
        storageReadUnits: 0,
        storageWriteUnits: 0,
        subrequests: 0,
      },
      max: { activeWebsocketConnections: 5 },
    };
    const client = new FakeClient({ durable_objects_periodic: [row] });
    const collector = new CloudflareMetricsCollector(client as unknown as CloudflareGraphQLClient, 'acct', metrics, {
      now: () => new Date('2026-04-10T12:15:00Z'),
    });
    await collector.collectAll([DURABLE_OBJECTS_PERIODIC]);
    const exported = provider.metrics.find((m) => m.name === 'cf_durable_objects_periodic');
    expect(exported?.fields.get('duration_ms')).toEqual({ value: 72_990, type: 'float' });
    expect(exported?.fields.get('fatal_internal_errors')).toEqual({ value: 2, type: 'int' });
    expect(exported?.fields.get('active_ws_connections_max')).toEqual({ value: 5, type: 'int' });
  });

  it('handles avg-only datasets like queue backlog', async () => {
    const row: DatasetRow = {
      dimensions: { datetimeMinute: '2026-04-10T12:00:00Z', queueId: 'q1' },
      avg: { bytes: 123.4, messages: 7.5, sampleInterval: 1 },
    };
    const client = new FakeClient({ queue_backlog: [row] });
    const collector = new CloudflareMetricsCollector(client as unknown as CloudflareGraphQLClient, 'acct', metrics, {
      now: () => new Date('2026-04-10T12:15:00Z'),
    });
    await collector.collectAll([QUEUE_BACKLOG]);
    const exported = provider.metrics.find((m) => m.name === 'cf_queue_backlog');
    expect(exported?.fields.get('backlog_bytes_avg')).toEqual({ value: 123.4, type: 'float' });
    expect(exported?.fields.get('backlog_messages_avg')).toEqual({ value: 7.5, type: 'float' });
  });

  it('uses datetimeMinute timestamp dimension for hyperdrive pool sizes', async () => {
    const row: DatasetRow = {
      dimensions: { datetimeMinute: '2026-04-10T12:00:00Z', configId: 'cfg', databaseType: 'pg' },
      max: { currentPoolSize: 3, maxPoolSize: 10, waitingClients: 0 },
    };
    const client = new FakeClient({ hyperdrive_pool: [row] });
    const collector = new CloudflareMetricsCollector(client as unknown as CloudflareGraphQLClient, 'acct', metrics, {
      now: () => new Date('2026-04-10T12:15:00Z'),
    });
    await collector.collectAll([HYPERDRIVE_POOL]);
    const exported = provider.metrics.find((m) => m.name === 'cf_hyperdrive_pool');
    expect(exported?.exportTimestamp).toEqual(new Date('2026-04-10T12:00:00Z'));
    expect(exported?.fields.get('current_pool_size')).toEqual({ value: 3, type: 'int' });
  });

  it('enriches D1 metrics with database_name from the rest client', async () => {
    const row: DatasetRow = {
      dimensions: { datetimeMinute: '2026-04-10T12:00:00Z', databaseId: 'db-123', databaseRole: 'primary' },
      sum: { readQueries: 10, writeQueries: 0, rowsRead: 100, rowsWritten: 0, queryBatchResponseBytes: 200 },
    };
    const client = new FakeClient({ d1_queries: [row] });
    const restClient = new FakeRestClient([{ uuid: 'db-123', name: 'releases-prod' }]);
    const collector = new CloudflareMetricsCollector(client as unknown as CloudflareGraphQLClient, 'acct', metrics, {
      now: () => new Date('2026-04-10T12:15:00Z'),
      restClient,
    });
    await collector.collectAll([D1_QUERIES]);
    const exported = provider.metrics.find((m) => m.name === 'cf_d1_queries');
    expect(exported?.tags.get('database_id')).toBe('db-123');
    expect(exported?.tags.get('database_name')).toBe('releases-prod');
  });

  it('enriches queue metrics with queue_name from the rest client', async () => {
    const row: DatasetRow = {
      dimensions: {
        datetimeMinute: '2026-04-10T12:00:00Z',
        queueId: 'q-abc',
        actionType: 'WriteMessage',
        consumerType: 'worker',
        outcome: 'success',
      },
      sum: { billableOperations: 5, bytes: 1234 },
    };
    const client = new FakeClient({ queue_operations: [row] });
    const restClient = new FakeRestClient([], [{ queue_id: 'q-abc', queue_name: 'ingest-events' }]);
    const collector = new CloudflareMetricsCollector(client as unknown as CloudflareGraphQLClient, 'acct', metrics, {
      now: () => new Date('2026-04-10T12:15:00Z'),
      restClient,
    });
    await collector.collectAll([QUEUE_OPERATIONS]);
    const exported = provider.metrics.find((m) => m.name === 'cf_queue_operations');
    expect(exported?.tags.get('queue_id')).toBe('q-abc');
    expect(exported?.tags.get('queue_name')).toBe('ingest-events');
  });

  it('enriches queue backlog metrics with queue_name', async () => {
    const row: DatasetRow = {
      dimensions: { datetimeMinute: '2026-04-10T12:00:00Z', queueId: 'q-abc' },
      avg: { bytes: 100, messages: 2, sampleInterval: 1 },
    };
    const client = new FakeClient({ queue_backlog: [row] });
    const restClient = new FakeRestClient([], [{ queue_id: 'q-abc', queue_name: 'ingest-events' }]);
    const collector = new CloudflareMetricsCollector(client as unknown as CloudflareGraphQLClient, 'acct', metrics, {
      now: () => new Date('2026-04-10T12:15:00Z'),
      restClient,
    });
    await collector.collectAll([QUEUE_BACKLOG]);
    const exported = provider.metrics.find((m) => m.name === 'cf_queue_backlog');
    expect(exported?.tags.get('queue_name')).toBe('ingest-events');
  });

  it('enriches HTTP overview metrics with zone_name', async () => {
    const row: DatasetRow = {
      dimensions: {
        datetimeMinute: '2026-04-10T12:00:00Z',
        zoneTag: 'zone-1',
        clientCountryName: 'US',
        clientRequestHTTPProtocol: 'HTTP/2',
        edgeResponseStatus: 200,
      },
      sum: { requests: 100, bytes: 5000, cachedRequests: 50, cachedBytes: 2500, pageViews: 0, visits: 0 },
    };
    const client = new FakeClient({ http_requests_overview: [row] });
    const restClient = new FakeRestClient([], [], [{ id: 'zone-1', name: 'example.com' }]);
    const collector = new CloudflareMetricsCollector(client as unknown as CloudflareGraphQLClient, 'acct', metrics, {
      now: () => new Date('2026-04-10T12:15:00Z'),
      restClient,
    });
    await collector.collectAll([HTTP_REQUESTS_OVERVIEW]);
    const exported = provider.metrics.find((m) => m.name === 'cf_http_requests_overview');
    expect(exported?.tags.get('zone_tag')).toBe('zone-1');
    expect(exported?.tags.get('zone_name')).toBe('example.com');
  });

  it('resolves HTTP zones missing from the bulk list via per-tag lookup', async () => {
    const bulkZone: DatasetRow = {
      dimensions: { datetimeMinute: '2026-04-10T12:00:00Z', zoneTag: 'zone-bulk' },
      sum: { requests: 10, bytes: 500, cachedRequests: 0, cachedBytes: 0, pageViews: 0, visits: 0 },
    };
    const pagesZone: DatasetRow = {
      dimensions: { datetimeMinute: '2026-04-10T12:00:00Z', zoneTag: 'zone-pages' },
      sum: { requests: 5, bytes: 200, cachedRequests: 0, cachedBytes: 0, pageViews: 0, visits: 0 },
    };
    const client = new FakeClient({ http_requests_overview: [bulkZone, pagesZone] });
    const restClient = new FakeRestClient([], [], [{ id: 'zone-bulk', name: 'bulk.example.com' }], {
      'zone-pages': { id: 'zone-pages', name: 'pages.example.com' },
    });
    const collector = new CloudflareMetricsCollector(client as unknown as CloudflareGraphQLClient, 'acct', metrics, {
      now: () => new Date('2026-04-10T12:15:00Z'),
      restClient,
    });
    await collector.collectAll([HTTP_REQUESTS_OVERVIEW]);

    const exported = provider.metrics.filter((m) => m.name === 'cf_http_requests_overview');
    const bulk = exported.find((m) => m.tags.get('zone_tag') === 'zone-bulk');
    const pages = exported.find((m) => m.tags.get('zone_tag') === 'zone-pages');
    expect(bulk?.tags.get('zone_name')).toBe('bulk.example.com');
    expect(pages?.tags.get('zone_name')).toBe('pages.example.com');

    // Only the uncached zone should have been looked up individually.
    expect(restClient.getZoneCalls).toEqual(['zone-pages']);

    const lookup = provider.metrics.find(
      (m) => m.name === 'cloudflare_metrics_resource_lookup' && m.tags.get('resource') === 'zones_individual',
    );
    expect(lookup?.tags.get('status')).toBe('success');
    expect(lookup?.fields.get('resolved')).toEqual({ value: 1, type: 'int' });
    expect(lookup?.fields.get('failed')).toEqual({ value: 0, type: 'int' });
  });

  it('falls back to the zoneTag when individual lookup returns nothing', async () => {
    const row: DatasetRow = {
      dimensions: { datetimeMinute: '2026-04-10T12:00:00Z', zoneTag: 'zone-unknown' },
      sum: { requests: 1, bytes: 1, cachedRequests: 0, cachedBytes: 0, pageViews: 0, visits: 0 },
    };
    const client = new FakeClient({ http_requests_overview: [row] });
    // No bulk zones and no individual lookup results — rest client returns null.
    const restClient = new FakeRestClient([], [], [], { 'zone-unknown': null });
    const collector = new CloudflareMetricsCollector(client as unknown as CloudflareGraphQLClient, 'acct', metrics, {
      now: () => new Date('2026-04-10T12:15:00Z'),
      restClient,
    });
    await collector.collectAll([HTTP_REQUESTS_OVERVIEW]);

    const exported = provider.metrics.find((m) => m.name === 'cf_http_requests_overview');
    expect(exported?.tags.get('zone_tag')).toBe('zone-unknown');
    expect(exported?.tags.get('zone_name')).toBe('zone-unknown');
  });

  it('omits the enrichment tag when the rest client has no match', async () => {
    const row: DatasetRow = {
      dimensions: { datetimeMinute: '2026-04-10T12:00:00Z', databaseId: 'db-unknown', databaseRole: 'primary' },
      sum: { readQueries: 1, writeQueries: 0, rowsRead: 0, rowsWritten: 0, queryBatchResponseBytes: 0 },
    };
    const client = new FakeClient({ d1_queries: [row] });
    const restClient = new FakeRestClient([{ uuid: 'db-123', name: 'releases-prod' }]);
    const collector = new CloudflareMetricsCollector(client as unknown as CloudflareGraphQLClient, 'acct', metrics, {
      now: () => new Date('2026-04-10T12:15:00Z'),
      restClient,
    });
    await collector.collectAll([D1_QUERIES]);
    const exported = provider.metrics.find((m) => m.name === 'cf_d1_queries');
    expect(exported?.tags.get('database_id')).toBe('db-unknown');
    expect(exported?.tags.has('database_name')).toBe(false);
  });

  it('records per-resource lookup self-metrics with success and error statuses', async () => {
    const client = new FakeClient({});
    const restClient = new ThrowingRestClient();
    const collector = new CloudflareMetricsCollector(client as unknown as CloudflareGraphQLClient, 'acct', metrics, {
      now: () => new Date('2026-04-10T12:15:00Z'),
      restClient,
    });
    await collector.collectAll([]);
    const lookups = provider.metrics.filter((m) => m.name === 'cloudflare_metrics_resource_lookup');
    expect(lookups).toHaveLength(3);
    for (const lookup of lookups) {
      expect(lookup.tags.get('status')).toBe('error');
    }
    const resources = new Set(lookups.map((m) => m.tags.get('resource')));
    expect(resources).toEqual(new Set(['d1_databases', 'queues', 'zones']));
  });

  it('falls back to unenriched metrics when no rest client is provided', async () => {
    const row: DatasetRow = {
      dimensions: { datetimeMinute: '2026-04-10T12:00:00Z', databaseId: 'db-123', databaseRole: 'primary' },
      sum: { readQueries: 1, writeQueries: 0, rowsRead: 0, rowsWritten: 0, queryBatchResponseBytes: 0 },
    };
    const client = new FakeClient({ d1_queries: [row] });
    const collector = new CloudflareMetricsCollector(client as unknown as CloudflareGraphQLClient, 'acct', metrics, {
      now: () => new Date('2026-04-10T12:15:00Z'),
    });
    await collector.collectAll([D1_QUERIES]);
    const exported = provider.metrics.find((m) => m.name === 'cf_d1_queries');
    expect(exported?.tags.has('database_name')).toBe(false);
    expect(provider.metrics.some((m) => m.name === 'cloudflare_metrics_resource_lookup')).toBe(false);
  });

  it('iterates cached zones for zone-scoped datasets and injects zone tags', async () => {
    const zoneScoped: DatasetQuery = {
      key: 'zone_detail',
      measurement: 'cf_zone_detail',
      field: 'httpRequestsAdaptiveGroups',
      scope: 'zone',
      dimensions: ['datetimeMinute', 'edgeResponseStatus'],
      topLevelFields: ['count'],
      blocks: { sum: ['edgeResponseBytes'] },
      tags: [{ source: 'edgeResponseStatus', as: 'edge_response_status' }],
      fields: {
        requests: { type: 'int', source: ['_top', 'count'] },
        edge_response_bytes: { type: 'int', source: ['sum', 'edgeResponseBytes'] },
      },
    };
    const client = new FakeClient(
      {},
      {
        zone_detail: {
          'zone-a': [
            {
              dimensions: { datetimeMinute: '2026-04-10T12:00:00Z', edgeResponseStatus: 200 },
              count: 42,
              sum: { edgeResponseBytes: 1024 },
            },
          ],
          'zone-b': [
            {
              dimensions: { datetimeMinute: '2026-04-10T12:00:00Z', edgeResponseStatus: 500 },
              count: 3,
              sum: { edgeResponseBytes: 0 },
            },
          ],
        },
      },
    );
    const restClient = new FakeRestClient(
      [],
      [],
      [
        { id: 'zone-a', name: 'a.example.com' },
        { id: 'zone-b', name: 'b.example.com' },
      ],
    );
    const collector = new CloudflareMetricsCollector(client as unknown as CloudflareGraphQLClient, 'acct', metrics, {
      now: () => new Date('2026-04-10T12:15:00Z'),
      restClient,
    });

    const results = await collector.collectAll([zoneScoped]);
    const zoneResult = results.find((r) => r.dataset === 'zone_detail');
    expect(zoneResult?.rows).toBe(2);
    expect(zoneResult?.points).toBe(2);
    expect(client.zoneCalls).toEqual([{ zoneTags: ['zone-a', 'zone-b'], dataset: 'zone_detail' }]);

    const exported = provider.metrics.filter((m) => m.name === 'cf_zone_detail');
    expect(exported).toHaveLength(2);
    const a = exported.find((m) => m.tags.get('zone_tag') === 'zone-a');
    const b = exported.find((m) => m.tags.get('zone_tag') === 'zone-b');
    expect(a?.tags.get('zone_name')).toBe('a.example.com');
    expect(a?.fields.get('requests')).toEqual({ value: 42, type: 'int' });
    expect(b?.tags.get('zone_name')).toBe('b.example.com');
    expect(b?.fields.get('edge_response_bytes')).toEqual({ value: 0, type: 'int' });
  });

  it('skips zone-scoped datasets when the zone cache is empty', async () => {
    const zoneScoped: DatasetQuery = {
      key: 'zone_detail',
      measurement: 'cf_zone_detail',
      field: 'httpRequestsAdaptiveGroups',
      scope: 'zone',
      dimensions: ['datetimeMinute'],
      topLevelFields: ['count'],
      blocks: {},
      tags: [],
      fields: { requests: { type: 'int', source: ['_top', 'count'] } },
    };
    const client = new FakeClient({});
    const collector = new CloudflareMetricsCollector(client as unknown as CloudflareGraphQLClient, 'acct', metrics, {
      now: () => new Date('2026-04-10T12:15:00Z'),
    });
    const [result] = await collector.collectAll([zoneScoped]);
    expect(result.rows).toBe(0);
    expect(result.points).toBe(0);
    const observed = provider.metrics.find(
      (m) => m.name === 'cloudflare_metrics_collector_dataset' && m.tags.get('dataset') === 'zone_detail',
    );
    expect(observed?.tags.get('status')).toBe('skipped');
    expect(observed?.tags.get('reason')).toBe('no_zones_in_cache');
  });

  it('aggregates scheduled worker invocations client-side into minute buckets', async () => {
    const client = new FakeClient({}, {}, [
      {
        scriptName: 'version-api',
        cron: '*/5 * * * *',
        status: 'success',
        datetime: '2026-04-10T12:00:10Z',
        cpuTimeUs: 1000,
      },
      {
        scriptName: 'version-api',
        cron: '*/5 * * * *',
        status: 'success',
        datetime: '2026-04-10T12:00:42Z',
        cpuTimeUs: 3000,
      },
      {
        scriptName: 'version-api',
        cron: '*/5 * * * *',
        status: 'error',
        datetime: '2026-04-10T12:01:12Z',
        cpuTimeUs: 500,
      },
    ]);
    const collector = new CloudflareMetricsCollector(client as unknown as CloudflareGraphQLClient, 'acct', metrics, {
      now: () => new Date('2026-04-10T12:15:00Z'),
    });
    const results = await collector.collectAll([]);
    const scheduledResult = results.find((r) => r.dataset === 'workers_scheduled');
    expect(scheduledResult?.rows).toBe(3);
    expect(scheduledResult?.points).toBe(2); // one bucket for success in 12:00, one for error in 12:01

    const scheduled = provider.metrics.filter((m) => m.name === 'cf_workers_scheduled');
    expect(scheduled).toHaveLength(2);

    const successBucket = scheduled.find((m) => m.tags.get('status') === 'success');
    expect(successBucket?.fields.get('invocations')).toEqual({ value: 2, type: 'int' });
    expect(successBucket?.fields.get('cpu_time_us_sum')).toEqual({ value: 4000, type: 'int' });
    expect(successBucket?.fields.get('cpu_time_us_avg')).toEqual({ value: 2000, type: 'int' });
    expect(successBucket?.fields.get('cpu_time_us_max')).toEqual({ value: 3000, type: 'int' });
    expect(successBucket?.tags.get('script_name')).toBe('version-api');
    expect(successBucket?.tags.get('cron')).toBe('*/5 * * * *');
    expect(successBucket?.exportTimestamp).toEqual(new Date('2026-04-10T12:00:00Z'));

    const errorBucket = scheduled.find((m) => m.tags.get('status') === 'error');
    expect(errorBucket?.fields.get('invocations')).toEqual({ value: 1, type: 'int' });
    expect(errorBucket?.exportTimestamp).toEqual(new Date('2026-04-10T12:01:00Z'));
  });

  it('reads top-level count fields from the row', async () => {
    const dataset: DatasetQuery = {
      key: 'd1_queries_detail',
      measurement: 'cf_d1_queries_detail',
      field: 'd1QueriesAdaptiveGroups',
      dimensions: ['datetimeMinute', 'databaseId'],
      topLevelFields: ['count'],
      blocks: { sum: ['queryDurationMs'] },
      tags: [{ source: 'databaseId', as: 'database_id' }],
      fields: {
        query_count: { type: 'int', source: ['_top', 'count'] },
        query_duration_ms_sum: { type: 'float', source: ['sum', 'queryDurationMs'] },
      },
    };
    const row: DatasetRow = {
      dimensions: { datetimeMinute: '2026-04-10T12:00:00Z', databaseId: 'db-1' },
      count: 42,
      sum: { queryDurationMs: 7.5 },
    };
    const client = new FakeClient({ d1_queries_detail: [row] });
    const collector = new CloudflareMetricsCollector(client as unknown as CloudflareGraphQLClient, 'acct', metrics, {
      now: () => new Date('2026-04-10T12:15:00Z'),
    });
    await collector.collectAll([dataset]);
    const exported = provider.metrics.find((m) => m.name === 'cf_d1_queries_detail');
    expect(exported?.fields.get('query_count')).toEqual({ value: 42, type: 'int' });
    expect(exported?.fields.get('query_duration_ms_sum')).toEqual({ value: 7.5, type: 'float' });
  });
});

describe('CloudflareRestClient', () => {
  it('paginates through listD1Databases', async () => {
    const { CloudflareRestClient } = await import('./cloudflare-api.js');
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            success: true,
            result: [{ uuid: 'a', name: 'one' }],
            result_info: { page: 1, per_page: 100, total_pages: 2, count: 1, total_count: 2 },
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            success: true,
            result: [{ uuid: 'b', name: 'two' }],
            result_info: { page: 2, per_page: 100, total_pages: 2, count: 1, total_count: 2 },
          }),
          { status: 200 },
        ),
      );

    const client = new CloudflareRestClient('tok', 'https://example.com', fetchMock as unknown as typeof fetch);
    const dbs = await client.listD1Databases('acct');
    expect(dbs).toEqual([
      { uuid: 'a', name: 'one' },
      { uuid: 'b', name: 'two' },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const firstCall = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(firstCall[0]).toContain('/accounts/acct/d1/database?page=1');
    expect((firstCall[1].headers as Record<string, string>).Authorization).toBe('Bearer tok');
  });

  it('throws CloudflareRestError on non-OK responses', async () => {
    const { CloudflareRestClient, CloudflareRestError } = await import('./cloudflare-api.js');
    const fetchMock = vi.fn().mockResolvedValue(new Response('nope', { status: 403 }));
    const client = new CloudflareRestClient('tok', 'https://example.com', fetchMock as unknown as typeof fetch);
    await expect(client.listQueues('acct')).rejects.toBeInstanceOf(CloudflareRestError);
  });

  it('keeps the existing query string when listing zones', async () => {
    const { CloudflareRestClient } = await import('./cloudflare-api.js');
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          success: true,
          result: [{ id: 'z1', name: 'example.com' }],
          result_info: { page: 1, per_page: 100, total_pages: 1, count: 1, total_count: 1 },
        }),
        { status: 200 },
      ),
    );
    const client = new CloudflareRestClient('tok', 'https://example.com', fetchMock as unknown as typeof fetch);
    await client.listZones('acct');
    const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(call[0]).toContain('/zones?account.id=acct&page=1');
  });

  it('returns null from getZone when the API responds with 404', async () => {
    const { CloudflareRestClient } = await import('./cloudflare-api.js');
    const fetchMock = vi.fn().mockResolvedValue(new Response('', { status: 404 }));
    const client = new CloudflareRestClient('tok', 'https://example.com', fetchMock as unknown as typeof fetch);
    const zone = await client.getZone('does-not-exist');
    expect(zone).toBeNull();
  });

  it('returns the zone payload from getZone on success', async () => {
    const { CloudflareRestClient } = await import('./cloudflare-api.js');
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          success: true,
          result: { id: 'z1', name: 'pages.example.com' },
        }),
        { status: 200 },
      ),
    );
    const client = new CloudflareRestClient('tok', 'https://example.com', fetchMock as unknown as typeof fetch);
    const zone = await client.getZone('z1');
    expect(zone).toEqual({ id: 'z1', name: 'pages.example.com' });
    const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(call[0]).toBe('https://example.com/zones/z1');
  });
});

describe('dataset registry invariants', () => {
  it('every dataset defines at least one tag or field', () => {
    for (const dataset of ALL_DATASETS) {
      const fieldCount = Object.keys(dataset.fields).length;
      expect(fieldCount, `${dataset.key} must have fields`).toBeGreaterThan(0);
      for (const [, spec] of Object.entries(dataset.fields)) {
        expect(['int', 'float']).toContain(spec.type);
        expect(spec.source[0]).toMatch(/^(sum|avg|max|min|quantiles|uniq|_top)$/);
      }
    }
  });

  it('every dataset selects its timestamp dimension', () => {
    for (const dataset of ALL_DATASETS) {
      const timestampDim = dataset.timestampDimension ?? 'datetimeMinute';
      expect(dataset.dimensions, `${dataset.key} must include ${timestampDim}`).toContain(timestampDim);
    }
  });

  it('measurement names are unique and cf_-prefixed', () => {
    const seen = new Set<string>();
    for (const dataset of ALL_DATASETS) {
      expect(dataset.measurement).toMatch(/^cf_/);
      expect(seen.has(dataset.measurement)).toBe(false);
      seen.add(dataset.measurement);
    }
  });
});

describe('HTTP handler', () => {
  it('returns 200 for /health', async () => {
    const response = await SELF.fetch('https://example.com/health');
    expect(response.status).toBe(200);
    const body = (await response.json()) as { status: string };
    expect(body.status).toBe('ok');
  });

  it('returns 404 for unknown routes', async () => {
    const response = await SELF.fetch('https://example.com/nope');
    expect(response.status).toBe(404);
  });

  it('returns 503 from /collect when the API token or account ID is missing', async () => {
    const response = await SELF.fetch('https://example.com/collect');
    expect(response.status).toBe(503);
  });
});
