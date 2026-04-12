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
      runCollection(env, metrics, graphqlClient, isColdStart),
    )();
    const totalPoints = results.reduce((acc, r) => acc + r.points, 0);
    const totalErrors = results.filter((r) => r.error).length;
    metrics.push(
      Metric.create('cron_summary')
        .intField('datasets', results.length)
        .intField('points', totalPoints)
        .intField('errors', totalErrors)
        .intField('cold_start', isColdStart ? 1 : 0),
    );
    console.log(
      `[cron] collected ${totalPoints} points across ${results.length} datasets (${totalErrors} errors${isColdStart ? ', cold start backfill' : ''})`,
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

async function runCollection(
  env: Env,
  metrics: CloudflareMetricsRepository,
  graphqlClient: CloudflareGraphQLClient,
  isColdStart: boolean,
) {
  const restClient = new CloudflareRestClient(env.CLOUDFLARE_API_TOKEN ?? '');
  // On cold start (fresh isolate), widen the window to 15 minutes to backfill
  // any data missed while the previous isolate was crashing. VM dedupes on
  // (series, timestamp) so the overlap with already-written data is free.
  const windowMs = isColdStart ? 15 * 60 * 1000 : undefined;
  const collector = new CloudflareMetricsCollector(graphqlClient, env.CLOUDFLARE_ACCOUNT_ID, metrics, {
    restClient,
    windowMs,
  });
  return collector.collectAll(ALL_DATASETS);
}
