import type { ICloudflareRestClient } from './cloudflare-api.js';
import type { CloudflareGraphQLClient } from './graphql-client.js';
import type { IMetricsProviderRepository } from './metric-providers.js';
import { Metric } from './metric.js';
import { CloudflareMetricsRepository } from './metrics.js';
import type { DatasetQuery, DatasetRow } from './types.js';

/**
 * Test-only metrics provider that records every pushed metric so tests can
 * assert on the emitted measurement name, tags, and fields without having to
 * parse the final line protocol.
 */
export class RecordingProvider implements IMetricsProviderRepository {
  readonly metrics: Metric[] = [];
  flushCount = 0;
  pushMetric(metric: Metric) {
    this.metrics.push(metric);
  }
  flush() {
    this.flushCount++;
  }
}

/**
 * Builds a metrics repository wrapping the given provider with the same
 * prefix (`cloudflare_metrics`) used in the production entrypoint. Tests
 * that care about the prefix get the same behaviour as real requests.
 */
export function buildMetricsRepo(provider: IMetricsProviderRepository) {
  return new CloudflareMetricsRepository('cloudflare_metrics', new Request('https://localhost/test'), [provider], '');
}

/**
 * Fake GraphQL client that returns pre-seeded rows for account and zone
 * datasets. Tests configure it with a map of datasetKey → rows and
 * optionally zone-scoped rows keyed by zoneTag.
 */
export class FakeGraphQLClient {
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

/** `FakeGraphQLClient` duck-typed as a `CloudflareGraphQLClient` for DI. */
export function asGraphQLClient(fake: FakeGraphQLClient): CloudflareGraphQLClient {
  return fake as unknown as CloudflareGraphQLClient;
}

/**
 * Fake REST client returning pre-seeded D1/queue/zone lookups. The
 * individualZones map is consulted by `getZone` so tests can pretend a
 * pages-only zone exists outside the bulk list.
 */
export class FakeRestClient implements ICloudflareRestClient {
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

/**
 * Rest client that always throws, used to test error paths on resource
 * lookups (e.g. the collector should still emit a self-metric rather than
 * crashing the whole cron tick).
 */
export class ThrowingRestClient implements ICloudflareRestClient {
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
