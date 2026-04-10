import type { AccountQueryResult, DatasetQuery, DatasetRow, GraphQLResponse } from './types.js';

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

export interface ICloudflareGraphQLClient {
  fetchDataset(accountTag: string, dataset: DatasetQuery, range: { start: Date; end: Date }): Promise<DatasetRow[]>;
}

export class CloudflareGraphQLClient implements ICloudflareGraphQLClient {
  constructor(
    private readonly apiToken: string,
    private readonly endpoint: string = CLOUDFLARE_GRAPHQL_ENDPOINT,
    private readonly fetchImpl: typeof fetch = fetch,
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

  async execute<T>(query: string, variables: Record<string, unknown>): Promise<GraphQLResponse<T>> {
    const response = await this.fetchImpl(this.endpoint, {
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

  return `query CloudflareMetrics($accountTag: String!, $filter: ${filterInputTypeFor(dataset)}!, $limit: Int!) {
  viewer {
    accounts(filter: { accountTag: $accountTag }) {
      ${dataset.field}(limit: $limit, filter: $filter${orderByClause(dataset)}) {
        dimensions { ${dimensionSelection} }
        ${blockSelections}
      }
    }
  }
}`;
}

export function buildDatasetVariables(
  accountTag: string,
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
  return {
    accountTag,
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
  const timestampDim = dataset.timestampDimension ?? 'datetimeFiveMinutes';
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
