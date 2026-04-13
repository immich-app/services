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

export async function handleScheduled(
  _controller: ScheduledController,
  env: Env,
  ctx: ExecutionContext,
): Promise<void> {
  isolateStartedAt ??= Date.now();
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
      runCollection(env, metrics, graphqlClient, isColdStart, lastSuccessfulEndMs),
    )();
    // Record the lagged end of the window we just queried so the next tick
    // knows where to pick up if there was a gap.
    const prevEnd = lastSuccessfulEndMs;
    lastSuccessfulEndMs = Date.now() - DEFAULT_LAG_MS;

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
      .intField('error_responses', graphqlClient.errorResponseCount),
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
const DEFAULT_WINDOW_MS = 3 * 60 * 1000;
const MAX_BACKFILL_MS = 60 * 60 * 1000; // 1 hour cap

function computeWindowMs(isColdStart: boolean, lastSuccessfulEndMs: number | null): number {
  if (lastSuccessfulEndMs !== null) {
    // We know exactly when we last queried — extend the window to cover the
    // gap. The collector's end = now - lag, so the gap is (now - lag) - lastEnd.
    const gapMs = Date.now() - DEFAULT_LAG_MS - lastSuccessfulEndMs;
    if (gapMs > DEFAULT_WINDOW_MS) {
      return Math.min(gapMs, MAX_BACKFILL_MS);
    }
    return DEFAULT_WINDOW_MS;
  }
  // Fresh isolate with no prior state — use a wide backfill window.
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
) {
  const restClient = new CloudflareRestClient(env.CLOUDFLARE_API_TOKEN ?? '');
  const windowMs = computeWindowMs(isColdStart, prevEndMs);
  const collector = new CloudflareMetricsCollector(graphqlClient, env.CLOUDFLARE_ACCOUNT_ID, metrics, {
    restClient,
    windowMs,
  });
  return collector.collectAll(ALL_DATASETS);
}
