import { beforeEach, describe, expect, it } from 'vitest';
import {
  __resetFlushStateForTests,
  MAX_PENDING_FLUSH_BYTES,
  pendingFlushBuffers,
  recordLastFlushStats,
  takeLastFlushStats,
} from './flush-state.js';

describe('flush-state', () => {
  beforeEach(() => {
    __resetFlushStateForTests();
  });

  describe('takeLastFlushStats', () => {
    it('returns null when no stats have been recorded', () => {
      expect(takeLastFlushStats()).toBeNull();
    });

    it('returns the recorded stats and clears them', () => {
      const stats = {
        bytes: 1024,
        durationMs: 50,
        status: 'ok' as const,
        pendingBuffers: 0,
        pendingBytes: 0,
      };
      recordLastFlushStats(stats);
      expect(takeLastFlushStats()).toEqual(stats);
      expect(takeLastFlushStats()).toBeNull();
    });

    it('returns the most recent stats when recorded multiple times', () => {
      recordLastFlushStats({ bytes: 100, durationMs: 10, status: 'ok', pendingBuffers: 0, pendingBytes: 0 });
      recordLastFlushStats({ bytes: 200, durationMs: 20, status: 'error', pendingBuffers: 1, pendingBytes: 100 });
      const stats = takeLastFlushStats();
      expect(stats?.bytes).toBe(200);
      expect(stats?.status).toBe('error');
    });
  });

  describe('pendingFlushBuffers', () => {
    it('starts empty', () => {
      expect(pendingFlushBuffers).toHaveLength(0);
    });

    it('is a mutable array', () => {
      pendingFlushBuffers.push('body1', 'body2');
      expect(pendingFlushBuffers).toHaveLength(2);
      expect(pendingFlushBuffers[0]).toBe('body1');
    });

    it('is cleared by reset', () => {
      pendingFlushBuffers.push('body');
      __resetFlushStateForTests();
      expect(pendingFlushBuffers).toHaveLength(0);
    });
  });

  describe('MAX_PENDING_FLUSH_BYTES', () => {
    it('is 10 MB', () => {
      expect(MAX_PENDING_FLUSH_BYTES).toBe(10 * 1024 * 1024);
    });
  });
});
