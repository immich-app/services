import { CloudflareRestClient } from '../cloudflare-api.js';
import { CloudflareMetricsCollector } from '../collector.js';
import { ALL_DATASETS } from '../datasets.js';
import { takeLastFlushStats } from '../flush-state.js';
import { CloudflareGraphQLClient } from '../graphql-client.js';
import { InfluxMetricsProvider } from '../metric-providers.js';
import { Metric } from '../metric.js';
import { CloudflareMetricsRepository } from '../metrics.js';

// Lazy-init on first handler call because Date.now() at module scope
// returns a frozen value in Workers (deploy time, not wall clock).
let isolateStartedAt: number | null = null;

// Track the end timestamp of the last successful collection so we can
// backfill the exact gap after crashes or missed ticks. Resets on isolate
// restart, in which case we fall back to a wide backfill window.
let lastSuccessfulEndMs: number | null = null;

export async function handleScheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
  isolateStartedAt ??= Date.now();
  // Cloudflare occasionally drops or delays cron triggers. When it recovers
  // from a gap it fires the missed triggers in a burst (~10 at once in
  // practice) all at the same wall-clock time. If we used Date.now() for
  // the query window, every catch-up invocation would query the same
  // "now - lag" range and the originally-scheduled minutes would be lost.
  // controller.scheduledTime is the time the cron was originally scheduled
  // for, so each catch-up tick covers its own intended window.
  const scheduledMs = controller.scheduledTime;
  const influxProvider = new InfluxMetricsProvider(env.VMETRICS_API_TOKEN ?? '', env.ENVIRONMENT ?? '');
  const request = new Request('https://localhost/cron');
  const metrics = new CloudflareMetricsRepository(
    'cloudflare_metrics',
    request,
    [influxProvider],
    env.ENVIRONMENT ?? '',
  );

  // Emit telemetry from the previous tick's flush (can't observe the flush
  // we're about to make from inside it). `takeLastFlushStats` clears after
  // read so a tick without a prior flush just skips these metrics.
  emitLastFlushStats(metrics);

  if (!env.CLOUDFLARE_API_TOKEN || !env.CLOUDFLARE_ACCOUNT_ID) {
    console.error('[cron] Missing CLOUDFLARE_API_TOKEN or CLOUDFLARE_ACCOUNT_ID — skipping collection');
    metrics.push(Metric.create('cron_error').addTag('reason', 'missing_config').intField('count', 1));
    ctx.waitUntil(influxProvider.flush());
    return;
  }

  const isolateAgeSec = Math.round((Date.now() - isolateStartedAt) / 1000);
  const isColdStart = isolateAgeSec < 120;

  const graphqlClient = new CloudflareGraphQLClient(env.CLOUDFLARE_API_TOKEN);
  try {
    const results = await metrics.monitorAsyncFunction({ name: 'cron_collect' }, () =>
      runCollection(env, metrics, graphqlClient, isColdStart, lastSuccessfulEndMs, scheduledMs),
    )();
    // Record the lagged end of the window we just queried so the next tick
    // knows where to pick up if there was a gap. Use scheduledMs (not wall
    // clock) so catch-up invocations advance the pointer in order.
    const prevEnd = lastSuccessfulEndMs;
    const thisEnd = scheduledMs - DEFAULT_LAG_MS;
    if (lastSuccessfulEndMs === null || thisEnd > lastSuccessfulEndMs) {
      lastSuccessfulEndMs = thisEnd;
    }

    const totalPoints = results.reduce((acc, r) => acc + r.points, 0);
    const totalErrors = results.filter((r) => r.error).length;
    const wasBackfill = isColdStart || prevEnd === null;
    metrics.push(
      Metric.create('cron_summary')
        .intField('datasets', results.length)
        .intField('points', totalPoints)
        .intField('errors', totalErrors)
        .intField('cold_start', isColdStart ? 1 : 0),
    );
    console.log(
      `[cron] collected ${totalPoints} points across ${results.length} datasets (${totalErrors} errors${wasBackfill ? ', backfill' : ''})`,
    );
  } catch (error) {
    console.error('[cron] Collection failed:', error);
    metrics.push(
      Metric.create('cron_error')
        .addTag('reason', error instanceof Error ? error.name : 'unknown')
        .intField('count', 1),
    );
  }

  for (const m of [
    Metric.create('graphql_client')
      .intField('requests', graphqlClient.requestCount)
      .intField('error_responses', graphqlClient.errorResponseCount)
      .intField('retries', graphqlClient.retryCount)
      .intField('retry_successes', graphqlClient.retrySuccessCount),
    Metric.create('isolate').intField('age_seconds', isolateAgeSec),
  ]) {
    metrics.push(m);
  }

  ctx.waitUntil(influxProvider.flush());
}

function emitLastFlushStats(metrics: CloudflareMetricsRepository): void {
  const stats = takeLastFlushStats();
  if (!stats) {
    return;
  }
  metrics.push(
    Metric.create('flush')
      .addTag('status', stats.status)
      .intField('bytes', stats.bytes)
      .intField('duration_ms', Math.round(stats.durationMs))
      .intField('pending_buffers', stats.pendingBuffers)
      .intField('pending_bytes', stats.pendingBytes)
      .intField('errors', stats.status === 'error' ? 1 : 0)
      .intField('count', 1),
  );
}

// Re-export for use in window calculation. Must stay in sync with the
// collector's default — but avoids a circular import.
const DEFAULT_LAG_MS = 5 * 60 * 1000;
const DEFAULT_WINDOW_MS = 5 * 60 * 1000;
const MAX_BACKFILL_MS = 30 * 60 * 1000; // 30-minute cap on recovery backfill

function computeWindowMs(isColdStart: boolean, lastSuccessfulEndMs: number | null, scheduledMs: number): number {
  if (lastSuccessfulEndMs !== null) {
    // We know exactly when we last queried — extend the window to cover the
    // gap. The collector's end = scheduled - lag, so the gap is
    // (scheduled - lag) - lastEnd. Using scheduled time (not wall clock)
    // so catch-up invocations compute the gap correctly.
    const gapMs = scheduledMs - DEFAULT_LAG_MS - lastSuccessfulEndMs;
    if (gapMs > DEFAULT_WINDOW_MS) {
      return Math.min(gapMs, MAX_BACKFILL_MS);
    }
    return DEFAULT_WINDOW_MS;
  }
  // Fresh isolate with no prior state — use a shorter backfill window
  // since cold-start ticks already do extra work resolving resource caches.
  if (isColdStart) {
    return 15 * 60 * 1000;
  }
  return DEFAULT_WINDOW_MS;
}

async function runCollection(
  env: Env,
  metrics: CloudflareMetricsRepository,
  graphqlClient: CloudflareGraphQLClient,
  isColdStart: boolean,
  prevEndMs: number | null,
  scheduledMs: number,
) {
  const restClient = new CloudflareRestClient(env.CLOUDFLARE_API_TOKEN ?? '');
  const windowMs = computeWindowMs(isColdStart, prevEndMs, scheduledMs);
  // Anchor the collector's "now" to the cron's scheduled time, not wall
  // clock. This keeps catch-up invocations (fired late by Cloudflare)
  // querying their originally-intended window instead of whatever the
  // wall clock says at recovery time.
  const collector = new CloudflareMetricsCollector(graphqlClient, env.CLOUDFLARE_ACCOUNT_ID, metrics, {
    restClient,
    windowMs,
    now: () => new Date(scheduledMs),
  });
  return collector.collectAll(ALL_DATASETS);
}
