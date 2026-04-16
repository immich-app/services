import { Metric } from './metric.js';
import type { ResourceCache } from './resource-cache.js';
import type { DatasetQuery, DatasetRow, FieldSpec } from './types.js';

// Precomputed per-dataset field entries to avoid Object.entries() per row.
// Keyed by dataset identity — safe because dataset objects are module-level
// constants that live for the lifetime of the isolate.
type FieldEntry = readonly [string, string, string, FieldSpec];
const fieldEntriesCache = new WeakMap<DatasetQuery, FieldEntry[]>();

function getFieldEntries(dataset: DatasetQuery): FieldEntry[] {
  let cached = fieldEntriesCache.get(dataset);
  if (!cached) {
    cached = Object.entries(dataset.fields).map(
      ([name, spec]) => [name, spec.source[0], spec.source[1], spec] as const,
    );
    fieldEntriesCache.set(dataset, cached);
  }
  return cached;
}

// Precomputed per-dataset resource tag enricher. The original code ran a
// `switch(dataset.field)` on every row — bypass that per-row work by
// resolving the correct enricher once per dataset and caching the closure.
type TagEnricher = (metric: Metric, row: DatasetRow, cache: ResourceCache) => void;
const noopEnricher: TagEnricher = () => {};
const tagEnricherCache = new WeakMap<DatasetQuery, TagEnricher>();

function getTagEnricher(dataset: DatasetQuery): TagEnricher {
  let cached = tagEnricherCache.get(dataset);
  if (cached) {
    return cached;
  }
  switch (dataset.field) {
    case 'd1AnalyticsAdaptiveGroups':
    case 'd1StorageAdaptiveGroups':
    case 'd1QueriesAdaptiveGroups': {
      cached = (metric, row, cache) => {
        const id = row.dimensions?.databaseId;
        if (typeof id === 'string' && id !== '') {
          const name = cache.d1Databases.get(id);
          if (name) {
            metric.addTag('database_name', name);
          }
        }
      };
      break;
    }
    case 'queueMessageOperationsAdaptiveGroups':
    case 'queueBacklogAdaptiveGroups': {
      cached = (metric, row, cache) => {
        const id = row.dimensions?.queueId;
        if (typeof id === 'string' && id !== '') {
          const name = cache.queues.get(id);
          if (name) {
            metric.addTag('queue_name', name);
          }
        }
      };
      break;
    }
    case 'httpRequestsOverviewAdaptiveGroups': {
      cached = (metric, row, cache) => {
        const tag = row.dimensions?.zoneTag;
        if (typeof tag === 'string' && tag !== '') {
          metric.addTag('zone_name', cache.zones.get(tag) ?? tag);
        }
      };
      break;
    }
    default: {
      cached = noopEnricher;
    }
  }
  tagEnricherCache.set(dataset, cached);
  return cached;
}

export function buildMetric(
  dataset: DatasetQuery,
  row: DatasetRow,
  accountTag: string,
  resourceCache: ResourceCache,
): Metric | null {
  const timestamp = resolveTimestamp(dataset, row);
  if (!timestamp) {
    return null;
  }

  const metric = Metric.create(dataset.measurement);
  metric.addTag('account_id', accountTag);
  metric.setExportTimestamp(timestamp);

  const dims = row.dimensions;
  for (const tag of dataset.tags) {
    const raw = dims?.[tag.source];
    const value = normalizeTagValue(raw);
    if (value !== undefined) {
      metric.addTag(tag.as, value);
    }
  }

  getTagEnricher(dataset)(metric, row, resourceCache);

  const rowAny = row as unknown as Record<string, unknown>;
  let hasField = false;
  for (const entry of getFieldEntries(dataset)) {
    const [fieldName, block, key, spec] = entry;
    let raw: number | null | undefined;
    if (block === '_top') {
      raw = rowAny[key] as number | null | undefined;
    } else {
      const blockData = rowAny[block] as Record<string, number | null> | undefined;
      raw = blockData?.[key];
    }
    if (raw === null || raw === undefined) {
      continue;
    }
    const value = spec.scale ? raw * spec.scale : raw;
    if (spec.type === 'float') {
      metric.floatField(fieldName, value);
    } else {
      metric.intField(fieldName, Math.round(value));
    }
    hasField = true;
  }

  if (!hasField) {
    return null;
  }

  return metric;
}

export function resolveTimestamp(dataset: DatasetQuery, row: DatasetRow): Date | null {
  const dimension = dataset.timestampDimension ?? 'datetimeMinute';
  const raw = row.dimensions?.[dimension];
  if (raw === null || raw === undefined) {
    return null;
  }
  const str = String(raw);
  // `date` dimension is "YYYY-MM-DD" — treat as UTC midnight.
  if (dimension === 'date') {
    return new Date(`${str}T00:00:00Z`);
  }
  const date = new Date(str);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return date;
}

export function normalizeTagValue(raw: unknown): string | undefined {
  if (raw === null || raw === undefined) {
    return undefined;
  }
  if (typeof raw === 'string') {
    return raw === '' ? undefined : raw;
  }
  if (typeof raw === 'number' || typeof raw === 'boolean') {
    return String(raw);
  }
  return undefined;
}
