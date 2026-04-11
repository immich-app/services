import type { AccountQueryResult, DatasetQuery, DatasetRow, GraphQLResponse } from './types.js';

const CLOUDFLARE_GRAPHQL_ENDPOINT = 'https://api.cloudflare.com/client/v4/graphql';
const DEFAULT_DATASET_LIMIT = 9999;
// Cloudflare GraphQL rejects batched queries above ~50 aliased datasets with a
// "too many nodes, zones and accounts" error. Keep well under that so chunks
// with higher-dimensionality datasets don't bump the ceiling either.
export const ACCOUNT_BATCH_CHUNK_SIZE = 25;

function chunkArray<T>(items: readonly T[], size: number): T[][] {
  if (size <= 0) {
    return items.length > 0 ? [[...items]] : [];
  }
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size) as T[]);
  }
  return chunks;
}

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

export class CloudflareGraphQLClient implements ICloudflareGraphQLClient {
  constructor(
    private readonly apiToken: string,
    private readonly endpoint: string = CLOUDFLARE_GRAPHQL_ENDPOINT,
    private readonly fetchImpl?: typeof fetch,
  ) {}

  async fetchAccountBatch(
    accountTag: string,
    datasets: readonly DatasetQuery[],
    range: { start: Date; end: Date },
    options: { includeScheduledInvocations?: boolean } = {},
  ): Promise<BatchedDatasetResult> {
    // Cloudflare's GraphQL endpoint enforces a "too many nodes, zones and
    // accounts" limit on combined query complexity. Empirically ~50 aliased
    // datasets is the ceiling; we chunk well below that to leave headroom
    // for datasets with extra blocks/dimensions.
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
    return (await response.json()) as GraphQLResponse<T>;
  }
}

async function safeReadText(response: Response): Promise<string | undefined> {
  try {
    return await response.text();
  } catch {
    return undefined;
  }
}

/**
 * Emits the inner selection for a single dataset — the aliased field, its
 * arguments, and the selection set — without the surrounding
 * `viewer.accounts { ... }` wrapper. Used by the batched query builders so
 * one query can carry many dataset selections.
 */
export function buildDatasetSelection(dataset: DatasetQuery, alias?: string): string {
  const dimensionSelection = dataset.dimensions.join(' ');
  const blockSelections = (Object.entries(dataset.blocks) as Array<[string, readonly string[] | undefined]>)
    .filter(([, fields]) => fields && fields.length > 0)
    .map(([block, fields]) => `${block} { ${(fields ?? []).join(' ')} }`)
    .join(' ');
  const topLevelSelection = (dataset.topLevelFields ?? []).join(' ');
  const limit = dataset.limit ?? DEFAULT_DATASET_LIMIT;
  const aliasPrefix = alias && alias !== dataset.field ? `${alias}: ` : '';
  return `${aliasPrefix}${dataset.field}(limit: ${limit}, filter: $filter${orderByClause(dataset)}) {
        dimensions { ${dimensionSelection} }
        ${topLevelSelection}
        ${blockSelections}
      }`;
}

const SCHEDULED_INVOCATIONS_SELECTION = `workers_scheduled: workersInvocationsScheduled(limit: ${DEFAULT_DATASET_LIMIT}, filter: $filter) {
        scriptName
        cron
        status
        datetime
        cpuTimeUs
      }`;

/**
 * Builds a single GraphQL query that pulls many account-scope datasets in
 * one HTTP request by aliasing each dataset. All datasets in the batch must
 * share the same filter granularity (datetime or date) because they share
 * the `$filter` variable.
 */
export function buildBatchedAccountQuery(
  datasets: readonly DatasetQuery[],
  includeScheduledInvocations = false,
): string {
  const selections = datasets.map((d) => buildDatasetSelection(d, d.key));
  if (includeScheduledInvocations) {
    selections.push(SCHEDULED_INVOCATIONS_SELECTION);
  }
  return `query CloudflareMetricsAccountBatch($accountTag: String!, $filter: JSON!) {
  viewer {
    accounts(filter: { accountTag: $accountTag }) {
      ${selections.join('\n      ')}
    }
  }
}`;
}

/**
 * Builds a single GraphQL query that fetches one dataset across many
 * zones. Each zoneTag becomes its own aliased `zones(...)` block.
 */
export function buildBatchedZoneQuery(zoneTags: readonly string[], dataset: DatasetQuery): string {
  const safeZoneTags = zoneTags.map((tag) => {
    if (!/^[a-zA-Z0-9_-]+$/.test(tag)) {
      throw new Error(`Invalid zoneTag for batched query: ${tag}`);
    }
    return tag;
  });
  const selections = safeZoneTags
    .map(
      (tag, index) => `    z${index}: zones(filter: { zoneTag: "${tag}" }) {
      ${buildDatasetSelection(dataset, dataset.field)}
    }`,
    )
    .join('\n');
  return `query CloudflareMetricsZoneBatch($filter: JSON!) {
  viewer {
${selections}
  }
}`;
}

/**
 * Builds the filter JSON object passed via `$filter` in both batched and
 * unbatched queries. Picks date-vs-datetime fields based on the dataset's
 * declared filter granularity; all datasets in a batch must agree on this.
 */
export function buildFilterObject(
  dataset: DatasetQuery | null,
  range: { start: Date; end: Date },
): Record<string, unknown> {
  const filter: Record<string, unknown> = dataset?.extraFilter ? { ...dataset.extraFilter } : {};
  if ((dataset?.filterGranularity ?? 'datetime') === 'date') {
    filter.date_geq = formatDateOnly(range.start);
    filter.date_leq = formatDateOnly(range.end);
  } else {
    filter.datetime_geq = range.start.toISOString();
    filter.datetime_leq = range.end.toISOString();
  }
  return filter;
}

/**
 * Converts the GraphQL `errors[]` array into a map from alias → message.
 * Cloudflare's error payloads include a `path` that begins with the
 * viewer → accounts/zones → aliased field; we walk it until we find an
 * alias we recognise. Errors without a resolvable alias are grouped under
 * an empty key and handled by the caller.
 */
export function groupErrorsByAlias(
  errors: GraphQLResponse<unknown>['errors'] | null | undefined,
): Record<string, string> {
  const result: Record<string, string> = {};
  if (!errors) {
    return result;
  }
  for (const error of errors) {
    const alias = findAliasInPath(error.path);
    if (alias) {
      const existing = result[alias];
      result[alias] = existing ? `${existing}; ${error.message}` : error.message;
    }
  }
  return result;
}

function findAliasInPath(path: readonly (string | number)[] | undefined): string | undefined {
  if (!path) {
    return undefined;
  }
  // Typical path shape:
  //   ['viewer', 'accounts', 0, '<alias>']
  //   ['viewer', '<alias>', 0, '<innerField>']   (zone batches)
  // Return the first path segment after a list index that isn't part of
  // the `dimensions` / `sum` / etc. internals.
  for (let i = 0; i < path.length; i++) {
    const segment = path[i];
    if (typeof segment !== 'string') {
      continue;
    }
    if (segment === 'viewer' || segment === 'accounts' || segment === 'zones') {
      continue;
    }
    return segment;
  }
  return undefined;
}

function orderByClause(dataset: DatasetQuery): string {
  const timestampDim = dataset.timestampDimension ?? 'datetimeMinute';
  // Grouping implicitly takes place on the dimensions, so orderBy helps
  // make sure we get the most recent buckets within the limit.
  if (dataset.dimensions.includes(timestampDim)) {
    return `, orderBy: [${timestampDim}_ASC]`;
  }
  return '';
}

function formatDateOnly(date: Date): string {
  // YYYY-MM-DD
  return date.toISOString().slice(0, 10);
}
