import { beforeEach, describe, expect, it } from 'vitest';
import { CloudflareMetricsCollector } from './collector.js';
import {
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
import type { CloudflareGraphQLClient } from './graphql-client.js';
import { type CloudflareMetricsRepository } from './metrics.js';
import { __resetResourceCachesForTests } from './resource-cache.js';
import {
  asGraphQLClient,
  buildMetricsRepo,
  FakeGraphQLClient,
  FakeRestClient,
  RecordingProvider,
  ThrowingRestClient,
} from './test-helpers.js';
import type { DatasetQuery, DatasetRow } from './types.js';

describe('CloudflareMetricsCollector', () => {
  let provider: RecordingProvider;
  let metrics: CloudflareMetricsRepository;

  beforeEach(() => {
    provider = new RecordingProvider();
    metrics = buildMetricsRepo(provider);
    __resetResourceCachesForTests();
  });

  it('computes a lagged query range so late-arriving buckets are included', () => {
    const now = new Date('2026-04-10T12:00:00Z');
    const collector = new CloudflareMetricsCollector(asGraphQLClient(new FakeGraphQLClient({})), 'acct', metrics, {
      now: () => now,
      lagMs: 2 * 60 * 1000,
      windowMs: 5 * 60 * 1000,
    });
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

    const client = new FakeGraphQLClient({ workers_invocations: [row] });
    const collector = new CloudflareMetricsCollector(asGraphQLClient(client), 'acct-xyz', metrics, {
      now: () => new Date('2026-04-10T12:15:00Z'),
    });

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
    const client = new FakeGraphQLClient({ r2_operations: [row] });
    const collector = new CloudflareMetricsCollector(asGraphQLClient(client), 'acct', metrics, {
      now: () => new Date('2026-04-10T12:15:00Z'),
    });
    await collector.collectAll([R2_OPERATIONS]);
    const exported = provider.metrics.find((m) => m.name === 'cf_r2_operations');
    expect(exported?.tags.get('response_status_code')).toBe('200');
    expect(exported?.tags.get('bucket_name')).toBe('my-bucket');
  });

  it('drops rows with neither a timestamp dimension nor any numeric field', async () => {
    const row: DatasetRow = { dimensions: { scriptName: 'no-timestamp' }, sum: { readQueries: 1 } };
    const client = new FakeGraphQLClient({ d1_queries: [row] });
    const collector = new CloudflareMetricsCollector(asGraphQLClient(client), 'acct', metrics, {
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
    const client = new FakeGraphQLClient({ d1_queries: [row] });
    const collector = new CloudflareMetricsCollector(asGraphQLClient(client), 'acct', metrics, {
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
    const client = new FakeGraphQLClient({ workers_invocations: [] });
    const collector = new CloudflareMetricsCollector(asGraphQLClient(client), 'acct', metrics, {
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
    const client = new FakeGraphQLClient({ durable_objects_storage: [row] });
    const collector = new CloudflareMetricsCollector(asGraphQLClient(client), 'acct', metrics, {
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
    const client = new FakeGraphQLClient({ durable_objects_periodic: [row] });
    const collector = new CloudflareMetricsCollector(asGraphQLClient(client), 'acct', metrics, {
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
    const client = new FakeGraphQLClient({ queue_backlog: [row] });
    const collector = new CloudflareMetricsCollector(asGraphQLClient(client), 'acct', metrics, {
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
    const client = new FakeGraphQLClient({ hyperdrive_pool: [row] });
    const collector = new CloudflareMetricsCollector(asGraphQLClient(client), 'acct', metrics, {
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
    const client = new FakeGraphQLClient({ d1_queries: [row] });
    const restClient = new FakeRestClient([{ uuid: 'db-123', name: 'releases-prod' }]);
    const collector = new CloudflareMetricsCollector(asGraphQLClient(client), 'acct', metrics, {
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
    const client = new FakeGraphQLClient({ queue_operations: [row] });
    const restClient = new FakeRestClient([], [{ queue_id: 'q-abc', queue_name: 'ingest-events' }]);
    const collector = new CloudflareMetricsCollector(asGraphQLClient(client), 'acct', metrics, {
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
    const client = new FakeGraphQLClient({ queue_backlog: [row] });
    const restClient = new FakeRestClient([], [{ queue_id: 'q-abc', queue_name: 'ingest-events' }]);
    const collector = new CloudflareMetricsCollector(asGraphQLClient(client), 'acct', metrics, {
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
    const client = new FakeGraphQLClient({ http_requests_overview: [row] });
    const restClient = new FakeRestClient([], [], [{ id: 'zone-1', name: 'example.com' }]);
    const collector = new CloudflareMetricsCollector(asGraphQLClient(client), 'acct', metrics, {
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
    const client = new FakeGraphQLClient({ http_requests_overview: [bulkZone, pagesZone] });
    const restClient = new FakeRestClient([], [], [{ id: 'zone-bulk', name: 'bulk.example.com' }], {
      'zone-pages': { id: 'zone-pages', name: 'pages.example.com' },
    });
    const collector = new CloudflareMetricsCollector(asGraphQLClient(client), 'acct', metrics, {
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
    const client = new FakeGraphQLClient({ http_requests_overview: [row] });
    // No bulk zones and no individual lookup results — rest client returns null.
    const restClient = new FakeRestClient([], [], [], { 'zone-unknown': null });
    const collector = new CloudflareMetricsCollector(asGraphQLClient(client), 'acct', metrics, {
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
    const client = new FakeGraphQLClient({ d1_queries: [row] });
    const restClient = new FakeRestClient([{ uuid: 'db-123', name: 'releases-prod' }]);
    const collector = new CloudflareMetricsCollector(asGraphQLClient(client), 'acct', metrics, {
      now: () => new Date('2026-04-10T12:15:00Z'),
      restClient,
    });
    await collector.collectAll([D1_QUERIES]);
    const exported = provider.metrics.find((m) => m.name === 'cf_d1_queries');
    expect(exported?.tags.get('database_id')).toBe('db-unknown');
    expect(exported?.tags.has('database_name')).toBe(false);
  });

  it('records per-resource lookup self-metrics with success and error statuses', async () => {
    const client = new FakeGraphQLClient({});
    const restClient = new ThrowingRestClient();
    const collector = new CloudflareMetricsCollector(asGraphQLClient(client), 'acct', metrics, {
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
    const client = new FakeGraphQLClient({ d1_queries: [row] });
    const collector = new CloudflareMetricsCollector(asGraphQLClient(client), 'acct', metrics, {
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
    const client = new FakeGraphQLClient(
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
    const collector = new CloudflareMetricsCollector(asGraphQLClient(client), 'acct', metrics, {
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
    const client = new FakeGraphQLClient({});
    const collector = new CloudflareMetricsCollector(asGraphQLClient(client), 'acct', metrics, {
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
    const client = new FakeGraphQLClient({}, {}, [
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
    const collector = new CloudflareMetricsCollector(asGraphQLClient(client), 'acct', metrics, {
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
    const client = new FakeGraphQLClient({ d1_queries_detail: [row] });
    const collector = new CloudflareMetricsCollector(asGraphQLClient(client), 'acct', metrics, {
      now: () => new Date('2026-04-10T12:15:00Z'),
    });
    await collector.collectAll([dataset]);
    const exported = provider.metrics.find((m) => m.name === 'cf_d1_queries_detail');
    expect(exported?.fields.get('query_count')).toEqual({ value: 42, type: 'int' });
    expect(exported?.fields.get('query_duration_ms_sum')).toEqual({ value: 7.5, type: 'float' });
  });
});
