export type FieldValue = number;

export type FieldType = 'int' | 'float';

// `['_top', 'count']` reads row.count directly; `['sum', 'requests']` reads row.sum.requests.
export type FieldSource = readonly [string, string];

export interface FieldSpec {
  type: FieldType;
  source: FieldSource;
  scale?: number;
}

export interface TagSpec {
  source: string;
  as: string;
}

export type AggregationBlock = 'sum' | 'avg' | 'max' | 'min' | 'quantiles' | 'uniq';

export interface DatasetQuery {
  key: string;
  measurement: string;
  field: string;
  scope?: 'account' | 'zone';
  dimensions: readonly string[];
  blocks: Partial<Record<AggregationBlock, readonly string[]>>;
  topLevelFields?: readonly string[];
  tags: readonly TagSpec[];
  fields: Record<string, FieldSpec>;
  timestampDimension?: string;
  filterGranularity?: 'datetime' | 'date';
  limit?: number;
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
  count?: number | null;
}

export interface GraphQLResponse<T> {
  data: T | null;
  errors?: Array<{
    message: string;
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
