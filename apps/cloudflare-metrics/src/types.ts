export type FieldValue = number;

export type FieldType = 'int' | 'float';

/**
 * Special marker for the top-level of the row. `['_top', 'count']` reads
 * `row.count` directly; standard aggregation blocks use `['sum', 'requests']`
 * etc. to read `row.sum.requests`.
 */
export type FieldSource = readonly [string, string];

export interface FieldSpec {
  type: FieldType;
  /** Source path into the GraphQL result row (e.g. ['sum', 'requests']) */
  source: FieldSource;
  /**
   * Optional scalar multiplier applied to the value before export.
   * Useful for unit normalization (e.g. seconds → milliseconds).
   */
  scale?: number;
}

export interface TagSpec {
  /** Path into dimensions used as the tag source */
  source: string;
  /** Tag name in the exported metric */
  as: string;
}

export type AggregationBlock = 'sum' | 'avg' | 'max' | 'min' | 'quantiles' | 'uniq';

export interface DatasetQuery {
  /** Human-friendly dataset key, also used in logging */
  key: string;
  /** Exported metric measurement name (e.g. "cf_workers_invocations") */
  measurement: string;
  /** The GraphQL field on `account` (or `zone`, see `scope`) to query */
  field: string;
  /**
   * Query scope. Most datasets live under `viewer.accounts`; a handful are
   * only accessible under `viewer.zones` (e.g. `httpRequestsAdaptiveGroups`
   * on plans where the account-level rollup is gated). When set to `zone`,
   * the collector iterates over the zones in the resource cache and runs
   * one query per zone, injecting the zone tag/name into the row before
   * emission.
   */
  scope?: 'account' | 'zone';
  /**
   * GraphQL dimensions to select (these also determine the grouping keys).
   * Must include at least one of `datetimeMinute`, `datetimeFiveMinutes`,
   * or `date` so rows can be timestamped.
   */
  dimensions: readonly string[];
  /** Blocks to query (sum, avg, max, etc.) with the fields inside each */
  blocks: Partial<Record<AggregationBlock, readonly string[]>>;
  /**
   * Top-level scalar fields to include in the selection (e.g. `count` on
   * `*AdaptiveGroups` datasets that expose an implicit row count). These
   * are read via a `['_top', fieldName]` source in the field spec.
   */
  topLevelFields?: readonly string[];
  /** Tag projection (dimension → tag name) */
  tags: readonly TagSpec[];
  /** Field projection (source path → exported field name) */
  fields: Record<string, FieldSpec>;
  /**
   * Dimension used to derive the metric timestamp. Defaults to
   * `datetimeMinute`.
   */
  timestampDimension?: string;
  /**
   * Filter granularity. Datasets that only support date-level filtering
   * (e.g. `durableObjectsStorageGroups`) use `date`. Datasets that support
   * datetime filtering use `datetime` (the default).
   */
  filterGranularity?: 'datetime' | 'date';
  /** Maximum rows to request per call */
  limit?: number;
  /** Optional extra filter clauses merged into the GraphQL filter object */
  extraFilter?: Record<string, unknown>;
}

export interface DatasetRow {
  dimensions: Record<string, string | number | null>;
  sum?: Record<string, number | null>;
  avg?: Record<string, number | null>;
  max?: Record<string, number | null>;
  min?: Record<string, number | null>;
  quantiles?: Record<string, number | null>;
  uniq?: Record<string, number | null>;
  /** Top-level row count on `*AdaptiveGroups` datasets. */
  count?: number | null;
}

export interface GraphQLResponse<T> {
  data: T | null;
  errors?: Array<{
    message: string;
    /** GraphQL `path` segments can be strings (field names) or numbers (list indices). */
    path?: Array<string | number>;
    extensions?: Record<string, unknown>;
  }> | null;
}

export interface AccountQueryResult {
  viewer: {
    accounts: Array<Record<string, unknown>>;
  };
}

export interface CollectionResult {
  dataset: string;
  rows: number;
  points: number;
  durationMs: number;
  error?: string;
}
