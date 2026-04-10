export type FieldValue = number;

export type FieldType = 'int' | 'float';

export interface FieldSpec {
  type: FieldType;
  /** Source path into the GraphQL result row (e.g. ['sum', 'requests']) */
  source: readonly [string, string];
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

export type AggregationBlock = 'sum' | 'avg' | 'max' | 'min' | 'quantiles';

export interface DatasetQuery {
  /** Human-friendly dataset key, also used in logging */
  key: string;
  /** Exported metric measurement name (e.g. "cf_workers_invocations") */
  measurement: string;
  /** The GraphQL field on `account` to query */
  field: string;
  /**
   * GraphQL dimensions to select (these also determine the grouping keys).
   * Must include at least one of `datetimeFiveMinutes` or `date` so rows
   * can be timestamped.
   */
  dimensions: readonly string[];
  /** Blocks to query (sum, avg, max, etc.) with the fields inside each */
  blocks: Partial<Record<AggregationBlock, readonly string[]>>;
  /** Tag projection (dimension → tag name) */
  tags: readonly TagSpec[];
  /** Field projection (source path → exported field name) */
  fields: Record<string, FieldSpec>;
  /**
   * Dimension used to derive the metric timestamp. Defaults to
   * `datetimeFiveMinutes`.
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
}

export interface GraphQLResponse<T> {
  data: T | null;
  errors?: Array<{
    message: string;
    path?: string[];
    extensions?: Record<string, unknown>;
  }> | null;
}

export interface AccountQueryResult {
  viewer: {
    accounts: Array<Record<string, DatasetRow[]>>;
  };
}

export interface CollectionResult {
  dataset: string;
  rows: number;
  points: number;
  durationMs: number;
  error?: string;
}
