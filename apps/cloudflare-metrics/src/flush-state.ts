export const pendingFlushBuffers: string[] = [];
// Cap retry buffer at 10 MB; eviction drops oldest-first.
export const MAX_PENDING_FLUSH_BYTES = 10 * 1024 * 1024;

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
