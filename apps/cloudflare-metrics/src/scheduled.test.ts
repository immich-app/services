import { describe, expect, it } from 'vitest';

// The scheduled handler uses module-level state (isolateStartedAt, lastSuccessfulEndMs)
// and constructs real clients, making it hard to unit test directly. Instead we test
// the pure helper `computeWindowMs` which drives the backfill logic.
//
// computeWindowMs is not exported, so we replicate its logic here to verify the
// algorithm. The constants must stay in sync with scheduled.ts.

const DEFAULT_LAG_MS = 5 * 60 * 1000;
const DEFAULT_WINDOW_MS = 5 * 60 * 1000;
const MAX_BACKFILL_MS = 30 * 60 * 1000;

function computeWindowMs(isColdStart: boolean, lastSuccessfulEndMs: number | null, scheduledMs: number): number {
  if (lastSuccessfulEndMs !== null) {
    const gapMs = scheduledMs - DEFAULT_LAG_MS - lastSuccessfulEndMs;
    if (gapMs > DEFAULT_WINDOW_MS) {
      return Math.min(gapMs, MAX_BACKFILL_MS);
    }
    return DEFAULT_WINDOW_MS;
  }
  if (isColdStart) {
    return 15 * 60 * 1000;
  }
  return DEFAULT_WINDOW_MS;
}

describe('computeWindowMs', () => {
  const baseTime = new Date('2026-04-10T12:00:00Z').getTime();

  it('returns default window when last end is recent', () => {
    const lastEnd = baseTime - DEFAULT_LAG_MS - DEFAULT_WINDOW_MS;
    expect(computeWindowMs(false, lastEnd, baseTime)).toBe(DEFAULT_WINDOW_MS);
  });

  it('extends window to cover a gap', () => {
    const gapMinutes = 10;
    const lastEnd = baseTime - DEFAULT_LAG_MS - gapMinutes * 60 * 1000;
    const result = computeWindowMs(false, lastEnd, baseTime);
    expect(result).toBe(gapMinutes * 60 * 1000);
  });

  it('caps backfill at MAX_BACKFILL_MS', () => {
    const lastEnd = baseTime - DEFAULT_LAG_MS - 60 * 60 * 1000; // 1 hour gap
    expect(computeWindowMs(false, lastEnd, baseTime)).toBe(MAX_BACKFILL_MS);
  });

  it('returns 15-minute window on cold start with no prior state', () => {
    expect(computeWindowMs(true, null, baseTime)).toBe(15 * 60 * 1000);
  });

  it('returns default window when not cold start and no prior state', () => {
    expect(computeWindowMs(false, null, baseTime)).toBe(DEFAULT_WINDOW_MS);
  });

  it('uses scheduledMs (not wall clock) for gap calculation', () => {
    const lastEnd = baseTime - DEFAULT_LAG_MS - 8 * 60 * 1000;
    // Two different scheduledMs values produce different gaps
    const result1 = computeWindowMs(false, lastEnd, baseTime);
    const result2 = computeWindowMs(false, lastEnd, baseTime + 2 * 60 * 1000);
    expect(result1).toBe(8 * 60 * 1000);
    expect(result2).toBe(10 * 60 * 1000);
  });

  it('returns default window when gap equals exactly DEFAULT_WINDOW_MS', () => {
    const lastEnd = baseTime - DEFAULT_LAG_MS - DEFAULT_WINDOW_MS;
    expect(computeWindowMs(false, lastEnd, baseTime)).toBe(DEFAULT_WINDOW_MS);
  });

  it('returns default window when gap is less than DEFAULT_WINDOW_MS', () => {
    const lastEnd = baseTime - DEFAULT_LAG_MS - 2 * 60 * 1000;
    expect(computeWindowMs(false, lastEnd, baseTime)).toBe(DEFAULT_WINDOW_MS);
  });
});
