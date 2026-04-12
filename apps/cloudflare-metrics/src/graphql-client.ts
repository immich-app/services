import {
  ACCOUNT_BATCH_CHUNK_SIZE,
  buildBatchedAccountQuery,
  buildBatchedZoneQuery,
  buildFilterObject,
  chunkArray,
  groupErrorsByAlias,
} from './graphql-builders.js';
import type { AccountQueryResult, DatasetQuery, DatasetRow, GraphQLResponse } from './types.js';

const CLOUDFLARE_GRAPHQL_ENDPOINT = 'https://api.cloudflare.com/client/v4/graphql';

// Re-export the builder helpers so existing imports from `graphql-client.js`
// keep working. A follow-up will switch call sites to import from
// `graphql-builders.js` directly.
export {
  ACCOUNT_BATCH_CHUNK_SIZE,
  buildBatchedAccountQuery,
  buildBatchedZoneQuery,
  buildDatasetSelection,
  buildFilterObject,
  groupErrorsByAlias,
} from './graphql-builders.js';

export class CloudflareGraphQLError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly responseBody?: string,
  ) {
    super(message);
    this.name = 'CloudflareGraphQLError';
  }
}

export interface ScheduledWorkerInvocation {
  scriptName: string;
  cron: string;
  status: string;
  datetime: string;
  cpuTimeUs: number;
}

export interface BatchedDatasetResult {
  /** Rows keyed by dataset.key (or 'workers_scheduled' for the special feed). */
  rows: Record<string, DatasetRow[]>;
  /** Per-alias error messages for fields that the server rejected. */
  errors: Record<string, string>;
  /** Raw scheduled-invocation feed when the batch requested it. */
  scheduledInvocations?: ScheduledWorkerInvocation[];
}

export interface BatchedZoneDatasetResult {
  /** Rows keyed by zoneTag. */
  rows: Record<string, DatasetRow[]>;
  /** Per-zone error messages for zones the server rejected. */
  errors: Record<string, string>;
}

export interface ICloudflareGraphQLClient {
  /**
   * Batched account-scope dataset fetch. All datasets passed in must share
   * the same filter granularity (datetime vs date). The special
   * `workersInvocationsScheduled` feed can be requested alongside the
   * datetime batch via `options.includeScheduledInvocations`.
   */
  fetchAccountBatch(
    accountTag: string,
    datasets: readonly DatasetQuery[],
    range: { start: Date; end: Date },
    options?: { includeScheduledInvocations?: boolean },
  ): Promise<BatchedDatasetResult>;
  /**
   * Batched zone-scope fetch for a single dataset across multiple zones.
   * Each zoneTag becomes an aliased `zones(filter: {...})` block in one
   * GraphQL operation.
   */
  fetchZoneBatch(
    zoneTags: readonly string[],
    dataset: DatasetQuery,
    range: { start: Date; end: Date },
  ): Promise<BatchedZoneDatasetResult>;
}

/**
 * Repository implementation that talks to the real Cloudflare GraphQL
 * Analytics API. Owns the HTTP transport, batching under the query-size
 * cap, and the request/error counters used by self-telemetry.
 */
export class CloudflareGraphQLClient implements ICloudflareGraphQLClient {
  /** Counter of HTTP requests issued to the Cloudflare GraphQL endpoint. */
  private _requestCount = 0;
  /** Counter of GraphQL responses that returned `errors[]`. */
  private _errorResponseCount = 0;

  constructor(
    private readonly apiToken: string,
    private readonly endpoint: string = CLOUDFLARE_GRAPHQL_ENDPOINT,
    private readonly fetchImpl?: typeof fetch,
  ) {}

  get requestCount(): number {
    return this._requestCount;
  }

  get errorResponseCount(): number {
    return this._errorResponseCount;
  }

  async fetchAccountBatch(
    accountTag: string,
    datasets: readonly DatasetQuery[],
    range: { start: Date; end: Date },
    options: { includeScheduledInvocations?: boolean } = {},
  ): Promise<BatchedDatasetResult> {
    // Cloudflare's GraphQL endpoint enforces a "too many nodes, zones and
    // accounts" limit on combined query complexity. Chunk well under the
    // empirical ~50-dataset ceiling to leave headroom for datasets with
    // extra blocks/dimensions.
    const chunks = chunkArray(datasets, ACCOUNT_BATCH_CHUNK_SIZE);
    if (chunks.length === 0 && options.includeScheduledInvocations) {
      chunks.push([]);
    }
    const result: BatchedDatasetResult = { rows: {}, errors: {} };

    for (const [i, chunk] of chunks.entries()) {
      // Only attach the scheduled-invocations field to the first chunk so we
      // don't fetch it multiple times.
      const includeScheduled = i === 0 && (options.includeScheduledInvocations ?? false);
      const chunkResult = await this.fetchAccountBatchChunk(accountTag, chunk, range, includeScheduled);
      Object.assign(result.rows, chunkResult.rows);
      Object.assign(result.errors, chunkResult.errors);
      if (includeScheduled) {
        if (chunkResult.errors.workers_scheduled) {
          result.errors.workers_scheduled = chunkResult.errors.workers_scheduled;
        } else {
          result.scheduledInvocations = chunkResult.scheduledInvocations ?? [];
        }
      }
    }

    return result;
  }

  private async fetchAccountBatchChunk(
    accountTag: string,
    datasets: readonly DatasetQuery[],
    range: { start: Date; end: Date },
    includeScheduledInvocations: boolean,
  ): Promise<BatchedDatasetResult> {
    const query = buildBatchedAccountQuery(datasets, includeScheduledInvocations);
    const variables = {
      accountTag,
      filter: buildFilterObject(datasets[0] ?? null, range),
    };
    const { data, errors } = await this.executeAllowPartial<AccountQueryResult>(query, variables);
    const result: BatchedDatasetResult = { rows: {}, errors: {} };

    const errorsByAlias = groupErrorsByAlias(errors);
    const account = data?.viewer.accounts[0];
    for (const dataset of datasets) {
      if (errorsByAlias[dataset.key]) {
        result.errors[dataset.key] = errorsByAlias[dataset.key];
        continue;
      }
      const rows = account?.[dataset.key] as unknown as DatasetRow[] | undefined;
      result.rows[dataset.key] = rows ?? [];
    }

    if (includeScheduledInvocations) {
      if (errorsByAlias.workers_scheduled) {
        result.errors.workers_scheduled = errorsByAlias.workers_scheduled;
      } else {
        result.scheduledInvocations = (account?.workers_scheduled as unknown as ScheduledWorkerInvocation[]) ?? [];
      }
    }

    // If the query returned no data and no aliased errors, surface a single
    // top-level error so callers can report it uniformly.
    if (!account && errors && errors.length > 0 && Object.keys(result.errors).length === 0) {
      const message = errors.map((e) => e.message).join('; ');
      for (const dataset of datasets) {
        result.errors[dataset.key] = message;
      }
      if (includeScheduledInvocations) {
        result.errors.workers_scheduled = message;
      }
    }

    return result;
  }

  async fetchZoneBatch(
    zoneTags: readonly string[],
    dataset: DatasetQuery,
    range: { start: Date; end: Date },
  ): Promise<BatchedZoneDatasetResult> {
    if (zoneTags.length === 0) {
      return { rows: {}, errors: {} };
    }
    const query = buildBatchedZoneQuery(zoneTags, dataset);
    const variables = {
      filter: buildFilterObject(dataset, range),
    };
    const { data, errors } = await this.executeAllowPartial<{
      viewer: Record<string, Array<Record<string, DatasetRow[]>>>;
    }>(query, variables);

    const result: BatchedZoneDatasetResult = { rows: {}, errors: {} };
    const errorsByAlias = groupErrorsByAlias(errors);
    const viewer = data?.viewer ?? {};
    for (const [index, zoneTag] of zoneTags.entries()) {
      const alias = `z${index}`;
      if (errorsByAlias[alias]) {
        result.errors[zoneTag] = errorsByAlias[alias];
        continue;
      }
      const zoneBlock = viewer[alias]?.[0];
      const rows = zoneBlock?.[dataset.field] ?? [];
      result.rows[zoneTag] = rows;
    }
    if (errors && errors.length > 0 && Object.keys(result.errors).length === 0) {
      const message = errors.map((e) => e.message).join('; ');
      for (const zoneTag of zoneTags) {
        result.errors[zoneTag] = message;
      }
    }
    return result;
  }

  /**
   * Executes a GraphQL query and returns both data and errors, tolerating
   * partial responses. Used by the batched fetch paths where one field
   * failing shouldn't kill the whole batch.
   */
  async executeAllowPartial<T>(query: string, variables: Record<string, unknown>): Promise<GraphQLResponse<T>> {
    const doFetch = this.fetchImpl ?? globalThis.fetch;
    if (typeof doFetch !== 'function') {
      throw new TypeError(`fetch is not a function (typeof=${typeof doFetch})`);
    }
    this._requestCount++;
    const response = await doFetch(this.endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query, variables }),
    });
    if (!response.ok) {
      const body = await safeReadText(response);
      throw new CloudflareGraphQLError(`Cloudflare GraphQL HTTP error (${response.status})`, response.status, body);
    }
    const parsed = (await response.json()) as GraphQLResponse<T>;
    if (parsed.errors && parsed.errors.length > 0) {
      this._errorResponseCount++;
    }
    return parsed;
  }
}

async function safeReadText(response: Response): Promise<string | undefined> {
  try {
    return await response.text();
  } catch {
    return undefined;
  }
}
