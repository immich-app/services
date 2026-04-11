import { describe, expect, it, vi } from 'vitest';
import { ALL_DATASETS, D1_QUERIES, DURABLE_OBJECTS_STORAGE, WORKERS_INVOCATIONS } from './datasets.js';
import {
  buildBatchedAccountQuery,
  buildBatchedZoneQuery,
  buildDatasetSelection,
  buildFilterObject,
  CloudflareGraphQLClient,
  CloudflareGraphQLError,
  groupErrorsByAlias,
} from './graphql-client.js';
import type { DatasetQuery } from './types.js';

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

  it('only includes the scheduled invocations field on the first chunk', async () => {
    // 60 datasets span 3 chunks at the default chunk size of 25.
    const datasets = Array.from({ length: 60 }, (_, i) => ({
      ...WORKERS_INVOCATIONS,
      key: `ds_${i}`,
      measurement: `cf_ds_${i}`,
    }));
    const fetchMock = vi.fn((_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      const aliases = [...body.query.matchAll(/(ds_\d+): workersInvocationsAdaptive/g)].map((m) => m[1]);
      const account: Record<string, unknown> = {};
      for (const alias of aliases) {
        account[alias] = [];
      }
      // When this chunk includes the scheduled feed, echo a single row back
      // so we can verify the collector only sees it once.
      if (body.query.includes('workers_scheduled: workersInvocationsScheduled')) {
        (account as Record<string, unknown>).workers_scheduled = [
          {
            scriptName: 's',
            cron: '* * * * *',
            status: 'success',
            datetime: '2026-04-10T12:00:00Z',
            cpuTimeUs: 100,
          },
        ];
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
    const result = await client.fetchAccountBatch(
      'acct',
      datasets,
      {
        start: new Date('2026-04-10T12:00:00Z'),
        end: new Date('2026-04-10T12:10:00Z'),
      },
      { includeScheduledInvocations: true },
    );

    // Exactly one chunk must include the scheduled-invocations selection;
    // the others should not ask for it at all.
    const scheduledCount = fetchMock.mock.calls.filter((call) => {
      const body = JSON.parse((call[1] as RequestInit).body as string);
      return (body.query as string).includes('workers_scheduled: workersInvocationsScheduled');
    }).length;
    expect(scheduledCount).toBe(1);
    // And the merged result should carry exactly one scheduled row.
    expect(result.scheduledInvocations).toHaveLength(1);
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

  it('counts graphql requests and error responses across multiple chunks', async () => {
    const datasets = Array.from({ length: 30 }, (_, i) => ({
      ...WORKERS_INVOCATIONS,
      key: `ds_${i}`,
      measurement: `cf_ds_${i}`,
    }));
    let calls = 0;
    const fetchMock = vi.fn((_url: string, init: RequestInit) => {
      calls++;
      const body = JSON.parse(init.body as string);
      const aliases = [...body.query.matchAll(/(ds_\d+): workersInvocationsAdaptive/g)].map((m) => m[1]);
      const account: Record<string, unknown> = {};
      for (const alias of aliases) {
        account[alias] = [];
      }
      // Return an error payload on the second chunk so `errorResponseCount`
      // has something to count.
      const errors =
        calls === 2 ? [{ message: 'transient', path: ['viewer', 'accounts', 0, aliases[0] ?? 'ds_0'] }] : null;
      return Promise.resolve(
        new Response(JSON.stringify({ data: { viewer: { accounts: [account] } }, errors }), { status: 200 }),
      );
    });
    const client = new CloudflareGraphQLClient(
      'tok',
      'https://example.com/graphql',
      fetchMock as unknown as typeof fetch,
    );
    await client.fetchAccountBatch('acct', datasets, {
      start: new Date('2026-04-10T12:00:00Z'),
      end: new Date('2026-04-10T12:10:00Z'),
    });

    expect(client.requestCount).toBe(fetchMock.mock.calls.length);
    expect(client.requestCount).toBeGreaterThanOrEqual(2);
    expect(client.errorResponseCount).toBe(1);
  });
});
