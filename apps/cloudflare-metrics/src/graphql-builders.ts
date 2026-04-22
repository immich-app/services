import type { DatasetQuery, GraphQLResponse } from './types.js';

export const DEFAULT_DATASET_LIMIT = 9999;

// Cloudflare GraphQL rejects batched queries above ~50 aliased datasets;
// 25 per chunk leaves headroom for datasets with extra blocks/dimensions.
export const ACCOUNT_BATCH_CHUNK_SIZE = 25;

export function chunkArray<T>(items: readonly T[], size: number): T[][] {
  if (size <= 0) {
    return items.length > 0 ? [[...items]] : [];
  }
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size) as T[]);
  }
  return chunks;
}

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

export function buildFilterObject(
  dataset: DatasetQuery | null,
  range: { start: Date; end: Date },
): Record<string, unknown> {
  const filter: Record<string, unknown> = dataset?.extraFilter ? { ...dataset.extraFilter } : {};
  filter.datetime_geq = range.start.toISOString();
  filter.datetime_leq = range.end.toISOString();
  return filter;
}

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
