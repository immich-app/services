export const pendingFlushBuffers: string[] = [];
// Cap the retry buffer very tightly. Larger caps accumulate state across
// failing ticks and make every subsequent flush slower — dragging CPU over
// the limit in a feedback loop. 1 MB = roughly one tick's worth of data;
// older data gets dropped rather than retried forever.
export const MAX_PENDING_FLUSH_BYTES = 1 * 1024 * 1024;

export interface LastFlushStats {
  bytes: number;
  durationMs: number;
  status: 'ok' | 'error';
  pendingBuffers: number;
  pendingBytes: number;
}

let lastFlushStats: LastFlushStats | null = null;

export function takeLastFlushStats(): LastFlushStats | null {
  const stats = lastFlushStats;
  lastFlushStats = null;
  return stats;
}

export function recordLastFlushStats(stats: LastFlushStats): void {
  lastFlushStats = stats;
}

export function __resetFlushStateForTests(): void {
  pendingFlushBuffers.length = 0;
  lastFlushStats = null;
}
