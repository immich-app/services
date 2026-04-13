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
  rows: Record<string, DatasetRow[]>;
  errors: Record<string, string>;
  scheduledInvocations?: ScheduledWorkerInvocation[];
}

export interface BatchedZoneDatasetResult {
  rows: Record<string, DatasetRow[]>;
  errors: Record<string, string>;
}

export interface ICloudflareGraphQLClient {
  fetchAccountBatch(
    accountTag: string,
    datasets: readonly DatasetQuery[],
    range: { start: Date; end: Date },
    options?: { includeScheduledInvocations?: boolean },
  ): Promise<BatchedDatasetResult>;
  fetchZoneBatch(
    zoneTags: readonly string[],
    dataset: DatasetQuery,
    range: { start: Date; end: Date },
  ): Promise<BatchedZoneDatasetResult>;
}

export class CloudflareGraphQLClient implements ICloudflareGraphQLClient {
  private _requestCount = 0;
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
    // Chunk under the ~50-dataset ceiling enforced by Cloudflare's GraphQL endpoint.
    const chunks = chunkArray(datasets, ACCOUNT_BATCH_CHUNK_SIZE);
    if (chunks.length === 0 && options.includeScheduledInvocations) {
      chunks.push([]);
    }
    const result: BatchedDatasetResult = { rows: {}, errors: {} };

    for (const [i, chunk] of chunks.entries()) {
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
    attempt = 1,
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

    // Retry once when all fields errored — likely a transient Cloudflare
    // analytics backend issue that resolves on the next attempt.
    const totalFields = datasets.length + (includeScheduledInvocations ? 1 : 0);
    if (attempt < 2 && totalFields > 0 && Object.keys(result.errors).length >= totalFields) {
      console.warn(`[graphql] all ${totalFields} fields errored, retrying chunk (attempt ${attempt + 1})`);
      // Undo the error response count from this attempt — the retry will
      // re-increment if it also fails, keeping the counter accurate.
      this._errorResponseCount--;
      await sleep(1000);
      return this.fetchAccountBatchChunk(accountTag, datasets, range, includeScheduledInvocations, attempt + 1);
    }

    return result;
  }

  async fetchZoneBatch(
    zoneTags: readonly string[],
    dataset: DatasetQuery,
    range: { start: Date; end: Date },
    attempt = 1,
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

    // Retry once when all zones errored.
    if (attempt < 2 && zoneTags.length > 0 && Object.keys(result.errors).length >= zoneTags.length) {
      console.warn(`[graphql] all ${zoneTags.length} zones errored for ${dataset.key}, retrying (attempt ${attempt + 1})`);
      this._errorResponseCount--;
      await sleep(1000);
      return this.fetchZoneBatch(zoneTags, dataset, range, attempt + 1);
    }

    return result;
  }

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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function safeReadText(response: Response): Promise<string | undefined> {
  try {
    return await response.text();
  } catch {
    return undefined;
  }
}
