/**
 * Module-level state used by `InfluxMetricsProvider` across Worker isolate
 * invocations. Isolates live long enough (minutes to hours) that keeping
 * the retry buffer and last-flush stats here works as a lightweight form
 * of persistence without a KV namespace.
 *
 * Split out from the provider class so test code can reset it without
 * poking at provider privates and so any future provider implementation
 * can share the same storage.
 */

/**
 * Buffered metrics line-protocol bodies whose flush attempt failed. On
 * the next successful flush they're prepended to the outgoing request so
 * a transient VictoriaMetrics outage doesn't drop data.
 *
 * Capped at 10 MB via `MAX_PENDING_FLUSH_BYTES`; when the cap is crossed
 * the eviction loop in the provider drops oldest-first.
 */
export const pendingFlushBuffers: string[] = [];
export const MAX_PENDING_FLUSH_BYTES = 10 * 1024 * 1024;

/**
 * Summary of the most recent flush attempt, surfaced to the next cron
 * tick as `cloudflare_metrics_flush_*` self-telemetry. `null` until the
 * first flush completes, and reset to `null` after one read via
 * `takeLastFlushStats()` — the consumer is responsible for doing
 * something useful with it before the next flush overwrites it.
 */
export interface LastFlushStats {
  bytes: number;
  durationMs: number;
  status: 'ok' | 'error';
  pendingBuffers: number;
  pendingBytes: number;
}

let lastFlushStats: LastFlushStats | null = null;

/** Consume the last flush's stats, returning `null` if nothing has flushed yet. */
export function takeLastFlushStats(): LastFlushStats | null {
  const stats = lastFlushStats;
  lastFlushStats = null;
  return stats;
}

/** Record new stats overwriting any un-consumed previous value. */
export function recordLastFlushStats(stats: LastFlushStats): void {
  lastFlushStats = stats;
}

/**
 * Test-only helper. Clears the retry buffer and stashed stats so each
 * test starts from a clean slate — the real isolate lifetime is long
 * enough that production code naturally shares state across cron ticks,
 * but tests run many `it` blocks against a single worker isolate and
 * need to reset by hand.
 */
export function __resetFlushStateForTests(): void {
  pendingFlushBuffers.length = 0;
  lastFlushStats = null;
}
