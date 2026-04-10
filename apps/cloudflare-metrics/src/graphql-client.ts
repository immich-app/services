import type { AccountQueryResult, DatasetQuery, DatasetRow, GraphQLResponse, ZoneQueryResult } from './types.js';

const CLOUDFLARE_GRAPHQL_ENDPOINT = 'https://api.cloudflare.com/client/v4/graphql';
const DEFAULT_DATASET_LIMIT = 9999;

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

export interface ICloudflareGraphQLClient {
  fetchDataset(accountTag: string, dataset: DatasetQuery, range: { start: Date; end: Date }): Promise<DatasetRow[]>;
  fetchZoneDataset(zoneTag: string, dataset: DatasetQuery, range: { start: Date; end: Date }): Promise<DatasetRow[]>;
  /**
   * `workersInvocationsScheduled` is a flat event list with no aggregation
   * block structure, so it lives outside the `DatasetQuery` model and has
   * its own fetch method.
   */
  fetchScheduledInvocations(
    accountTag: string,
    range: { start: Date; end: Date },
  ): Promise<ScheduledWorkerInvocation[]>;
}

export class CloudflareGraphQLClient implements ICloudflareGraphQLClient {
  constructor(
    private readonly apiToken: string,
    private readonly endpoint: string = CLOUDFLARE_GRAPHQL_ENDPOINT,
    private readonly fetchImpl?: typeof fetch,
  ) {}

  async fetchDataset(
    accountTag: string,
    dataset: DatasetQuery,
    range: { start: Date; end: Date },
  ): Promise<DatasetRow[]> {
    const query = buildDatasetQuery(dataset);
    const variables = buildDatasetVariables(accountTag, dataset, range);
    const response = await this.execute<AccountQueryResult>(query, variables);
    const accounts = response.data?.viewer.accounts ?? [];
    if (accounts.length === 0) {
      return [];
    }
    const rows = accounts[0][dataset.field];
    return rows ?? [];
  }

  async fetchZoneDataset(
    zoneTag: string,
    dataset: DatasetQuery,
    range: { start: Date; end: Date },
  ): Promise<DatasetRow[]> {
    const query = buildDatasetQuery(dataset);
    const variables = buildDatasetVariables(zoneTag, dataset, range);
    const response = await this.execute<ZoneQueryResult>(query, variables);
    const zones = response.data?.viewer.zones ?? [];
    if (zones.length === 0) {
      return [];
    }
    const rows = zones[0][dataset.field];
    return rows ?? [];
  }

  async fetchScheduledInvocations(
    accountTag: string,
    range: { start: Date; end: Date },
  ): Promise<ScheduledWorkerInvocation[]> {
    const query = `query ScheduledInvocations($accountTag: String!, $filter: JSON!, $limit: Int!) {
  viewer {
    accounts(filter: { accountTag: $accountTag }) {
      workersInvocationsScheduled(limit: $limit, filter: $filter) {
        scriptName
        cron
        status
        datetime
        cpuTimeUs
      }
    }
  }
}`;
    const variables = {
      accountTag,
      filter: {
        datetime_geq: range.start.toISOString(),
        datetime_leq: range.end.toISOString(),
      },
      limit: DEFAULT_DATASET_LIMIT,
    };
    const response = await this.execute<{
      viewer: { accounts: Array<{ workersInvocationsScheduled: ScheduledWorkerInvocation[] }> };
    }>(query, variables);
    const accounts = response.data?.viewer.accounts ?? [];
    if (accounts.length === 0) {
      return [];
    }
    return accounts[0].workersInvocationsScheduled ?? [];
  }

  async execute<T>(query: string, variables: Record<string, unknown>): Promise<GraphQLResponse<T>> {
    // Look up `fetch` lazily at call time rather than capturing it in a
    // constructor default, so we always get the current Worker runtime's
    // global even if this instance was constructed in a weird scope.
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

    const payload = (await response.json()) as GraphQLResponse<T>;
    if (payload.errors && payload.errors.length > 0) {
      throw new CloudflareGraphQLError(
        `Cloudflare GraphQL errors: ${payload.errors.map((e) => e.message).join('; ')}`,
        response.status,
        JSON.stringify(payload.errors),
      );
    }
    return payload;
  }
}

async function safeReadText(response: Response): Promise<string | undefined> {
  try {
    return await response.text();
  } catch {
    return undefined;
  }
}

export function buildDatasetQuery(dataset: DatasetQuery): string {
  const dimensionSelection = dataset.dimensions.join(' ');
  const blockSelections = (Object.entries(dataset.blocks) as Array<[string, readonly string[] | undefined]>)
    .filter(([, fields]) => fields && fields.length > 0)
    .map(([block, fields]) => `${block} { ${(fields ?? []).join(' ')} }`)
    .join(' ');
  const topLevelSelection = (dataset.topLevelFields ?? []).join(' ');
  const scope = dataset.scope ?? 'account';
  const rootFilterArg = scope === 'zone' ? 'zoneTag' : 'accountTag';
  const rootField = scope === 'zone' ? 'zones' : 'accounts';

  return `query CloudflareMetrics($${rootFilterArg}: String!, $filter: ${filterInputTypeFor(dataset)}!, $limit: Int!) {
  viewer {
    ${rootField}(filter: { ${rootFilterArg}: $${rootFilterArg} }) {
      ${dataset.field}(limit: $limit, filter: $filter${orderByClause(dataset)}) {
        dimensions { ${dimensionSelection} }
        ${topLevelSelection}
        ${blockSelections}
      }
    }
  }
}`;
}

export function buildDatasetVariables(
  contextTag: string,
  dataset: DatasetQuery,
  range: { start: Date; end: Date },
): Record<string, unknown> {
  const filter: Record<string, unknown> = dataset.extraFilter ? { ...dataset.extraFilter } : {};
  if ((dataset.filterGranularity ?? 'datetime') === 'date') {
    filter.date_geq = formatDateOnly(range.start);
    filter.date_leq = formatDateOnly(range.end);
  } else {
    filter.datetime_geq = range.start.toISOString();
    filter.datetime_leq = range.end.toISOString();
  }
  const rootFilterArg = dataset.scope === 'zone' ? 'zoneTag' : 'accountTag';
  return {
    [rootFilterArg]: contextTag,
    filter,
    limit: dataset.limit ?? DEFAULT_DATASET_LIMIT,
  };
}

function filterInputTypeFor(_dataset: DatasetQuery): string {
  // We use `JSON` here because the Cloudflare schema has a distinct input
  // object type per dataset (e.g. `AccountD1AnalyticsAdaptiveGroupsFilter_InputObject`)
  // which would force us to maintain a mapping for every dataset. Sending a
  // JSON value is accepted by the Cloudflare GraphQL API and keeps the
  // registry compact.
  return 'JSON';
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
