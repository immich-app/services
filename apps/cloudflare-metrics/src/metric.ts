export type MetricFieldType = 'int' | 'float' | 'duration';

/**
 * Tagged, typed metric point used by the cloudflare-metrics worker. Mutable
 * builder-style API: `Metric.create('cf_workers').addTag(...).intField(...)`.
 *
 * The `_timestamp` captured in the constructor is a monotonic timer used by
 * `durationField()` as a "now" anchor; the real wall-clock timestamp written
 * to the metrics backend comes from `setExportTimestamp()` when the metric
 * represents a historical data point (e.g. a Cloudflare analytics bucket
 * from several minutes ago).
 */
export class Metric {
  private _tags = new Map<string, string>();
  private _timestamp = performance.now();
  private _exportTimestamp: Date | undefined;
  private _fields = new Map<string, { value: number; type: MetricFieldType }>();
  private constructor(private _name: string) {}

  static create(name: string) {
    return new Metric(name);
  }

  get tags() {
    return this._tags;
  }

  get timestamp() {
    return this._timestamp;
  }

  get exportTimestamp() {
    return this._exportTimestamp;
  }

  get fields() {
    return this._fields;
  }

  get name() {
    return this._name;
  }

  prefixName(prefix: string) {
    if (!this._name.startsWith(`${prefix}_`)) {
      this._name = `${prefix}_${this._name}`;
    }
  }

  addTag(key: string, value: string) {
    this._tags.set(key, value);
    return this;
  }

  addTags(tags: Record<string, string>) {
    for (const [key, value] of Object.entries(tags)) {
      this._tags.set(key, value);
    }
    return this;
  }

  durationField(key: string, duration?: number) {
    this._fields.set(key, { value: duration ?? performance.now() - this._timestamp, type: 'duration' });
    return this;
  }

  intField(key: string, value: number) {
    this._fields.set(key, { value, type: 'int' });
    return this;
  }

  floatField(key: string, value: number) {
    this._fields.set(key, { value, type: 'float' });
    return this;
  }

  /**
   * Override the timestamp written to the metrics backend. When unset the
   * metrics provider uses the time at which the point is flushed.
   */
  setExportTimestamp(date: Date) {
    this._exportTimestamp = date;
    return this;
  }
}
