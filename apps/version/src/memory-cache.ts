export interface CacheResult<T> {
  value: T;
  stale: boolean;
}

export class MemoryCache<T> {
  private data: T | null = null;
  private expiresAt = 0;

  constructor(private ttlMs: number) {}

  get(): CacheResult<T> | null {
    if (this.data === null) {
      return null;
    }

    return {
      value: this.data,
      stale: Date.now() >= this.expiresAt,
    };
  }

  set(value: T): void {
    this.data = value;
    this.expiresAt = Date.now() + this.ttlMs;
  }

  invalidate(): void {
    this.data = null;
    this.expiresAt = 0;
  }
}
