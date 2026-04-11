import { createExecutionContext, createScheduledController, env, SELF, waitOnExecutionContext } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import worker from './index.js';
import { __resetMetricsModuleStateForTests } from './metrics.js';

describe('HTTP handler', () => {
  it('returns 200 for /health', async () => {
    const response = await SELF.fetch('https://example.com/health');
    expect(response.status).toBe(200);
    const body = (await response.json()) as { status: string };
    expect(body.status).toBe('ok');
  });

  it('returns 404 for unknown routes', async () => {
    const response = await SELF.fetch('https://example.com/nope');
    expect(response.status).toBe(404);
  });

  it('returns 404 for /collect — the manual trigger endpoint has been removed', async () => {
    const response = await SELF.fetch('https://example.com/collect');
    expect(response.status).toBe(404);
  });
});

describe('scheduled handler', () => {
  beforeEach(() => {
    __resetMetricsModuleStateForTests();
  });

  it('emits cron_error{reason=missing_config} when API token or account ID are missing', async () => {
    // Collect metric flush bodies seen by the victoria-metrics POST so we
    // can assert on the cron_error line without touching internal state.
    const originalFetch = globalThis.fetch;
    const flushBodies: string[] = [];
    globalThis.fetch = ((url: RequestInfo | URL, init?: RequestInit) => {
      const target = typeof url === 'string' ? url : url.toString();
      if (target.includes('/write')) {
        flushBodies.push(init?.body as string);
        return Promise.resolve(new Response('', { status: 204 }));
      }
      return Promise.resolve(new Response('', { status: 200 }));
    }) as typeof fetch;

    const controller = createScheduledController();
    const ctx = createExecutionContext();
    try {
      // env has no CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID bindings
      // in the test config, so this hits the early-return missing-config
      // branch.
      await worker.scheduled?.(controller, env as unknown as Env, ctx);
      await waitOnExecutionContext(ctx);
    } finally {
      globalThis.fetch = originalFetch;
    }

    const combined = flushBodies.join('\n');
    expect(combined).toContain('cloudflare_metrics_cron_error');
    expect(combined).toContain('reason=missing_config');
  });

  it('pushes flush self-telemetry to victoria-metrics on the next tick', async () => {
    // First tick: a successful flush populates lastFlushStats.
    // Second tick: takeLastFlushStats() drains it and emits
    // cloudflare_metrics_flush_* lines to the second tick's flush body.
    const originalFetch = globalThis.fetch;
    const flushBodies: string[] = [];
    globalThis.fetch = ((url: RequestInfo | URL, init?: RequestInit) => {
      const target = typeof url === 'string' ? url : url.toString();
      if (target.includes('/write')) {
        flushBodies.push(init?.body as string);
        return Promise.resolve(new Response('', { status: 204 }));
      }
      return Promise.resolve(new Response('', { status: 200 }));
    }) as typeof fetch;

    try {
      const controller = createScheduledController();
      // Tick 1 — missing-config path still triggers a flush.
      const ctx1 = createExecutionContext();
      await worker.scheduled?.(controller, env as unknown as Env, ctx1);
      await waitOnExecutionContext(ctx1);

      // Tick 2 — should emit the flush self-telemetry from tick 1's flush.
      const ctx2 = createExecutionContext();
      await worker.scheduled?.(controller, env as unknown as Env, ctx2);
      await waitOnExecutionContext(ctx2);
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(flushBodies.length).toBeGreaterThanOrEqual(2);
    // The second body should contain flush-* lines driven by lastFlushStats
    // captured during the first flush.
    const secondBody = flushBodies[1] ?? '';
    expect(secondBody).toContain('cloudflare_metrics_flush');
    expect(secondBody).toMatch(/cloudflare_metrics_flush[^\s]*status=ok/);
  });
});
