export class MemoryCache<T> {
  private data: T | null = null;
  private expiresAt = 0;

  constructor(private ttlMs: number) {}

  get(): T | null {
    if (this.data !== null && Date.now() < this.expiresAt) {
      return this.data;
    }
    return null;
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
