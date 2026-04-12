import { Metric } from './metric.js';
import type { ResourceCache } from './resource-cache.js';
import type { DatasetQuery, DatasetRow } from './types.js';

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

  for (const tag of dataset.tags) {
    const raw = row.dimensions?.[tag.source];
    const value = normalizeTagValue(raw);
    if (value !== undefined) {
      metric.addTag(tag.as, value);
    }
  }

  applyResourceTags(metric, dataset, row, resourceCache);

  let hasField = false;
  for (const [fieldName, spec] of Object.entries(dataset.fields)) {
    const [block, key] = spec.source;
    let raw: number | null | undefined;
    if (block === '_top') {
      // Read a top-level scalar (e.g. `count` on *AdaptiveGroups rows)
      raw = (row as unknown as Record<string, number | null | undefined>)[key];
    } else {
      const blockData = (row as unknown as Record<string, Record<string, number | null> | undefined>)[block];
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

export function applyResourceTags(metric: Metric, dataset: DatasetQuery, row: DatasetRow, cache: ResourceCache): void {
  const dims = row.dimensions ?? {};
  switch (dataset.field) {
    case 'd1AnalyticsAdaptiveGroups':
    case 'd1StorageAdaptiveGroups':
    case 'd1QueriesAdaptiveGroups': {
      const id = normalizeTagValue(dims.databaseId);
      const name = id ? cache.d1Databases.get(id) : undefined;
      if (name) {
        metric.addTag('database_name', name);
      }
      break;
    }
    case 'queueMessageOperationsAdaptiveGroups':
    case 'queueBacklogAdaptiveGroups': {
      const id = normalizeTagValue(dims.queueId);
      const name = id ? cache.queues.get(id) : undefined;
      if (name) {
        metric.addTag('queue_name', name);
      }
      break;
    }
    case 'httpRequestsOverviewAdaptiveGroups': {
      const tag = normalizeTagValue(dims.zoneTag);
      if (tag) {
        // Always populate `zone_name`, falling back to the zoneTag when the
        // name lookup didn't succeed. This keeps dashboard legends populated
        // for zones we can't resolve (e.g. ex-sub-accounts, zones we no
        // longer own) without leaving the series unlabelled.
        metric.addTag('zone_name', cache.zones.get(tag) ?? tag);
      }
      break;
    }
    default:
    // no enrichment for this dataset
  }
}
