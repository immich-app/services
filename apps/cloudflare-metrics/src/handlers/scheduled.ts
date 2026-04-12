import { CloudflareRestClient } from '../cloudflare-api.js';
import { CloudflareMetricsCollector } from '../collector.js';
import { ALL_DATASETS } from '../datasets.js';
import { takeLastFlushStats } from '../flush-state.js';
import { CloudflareGraphQLClient } from '../graphql-client.js';
import { InfluxMetricsProvider } from '../metric-providers.js';
import { Metric } from '../metric.js';
import { CloudflareMetricsRepository } from '../metrics.js';

/**
 * Cron handler for the cloudflare-metrics worker. Runs once per cron tick
 * (every minute by default) and performs the full collect + flush cycle:
 *
 *   1. Emit self-telemetry from the previous tick's flush (bytes, errors,
 *      pending buffer depth).
 *   2. Short-circuit with a `cron_error{reason=missing_config}` metric
 *      when required credentials are missing.
 *   3. Run the collector against every dataset in the registry.
 *   4. Record the graphql client's per-tick request + error-response
 *      counts as `graphql_client_*`.
 *   5. Flush buffered metrics to VictoriaMetrics.
 */
export async function handleScheduled(
  _controller: ScheduledController,
  env: Env,
  ctx: ExecutionContext,
): Promise<void> {
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

  const graphqlClient = new CloudflareGraphQLClient(env.CLOUDFLARE_API_TOKEN);
  try {
    const results = await metrics.monitorAsyncFunction({ name: 'cron_collect' }, () =>
      runCollection(env, metrics, graphqlClient),
    )();
    const totalPoints = results.reduce((acc, r) => acc + r.points, 0);
    const totalErrors = results.filter((r) => r.error).length;
    metrics.push(
      Metric.create('cron_summary')
        .intField('datasets', results.length)
        .intField('points', totalPoints)
        .intField('errors', totalErrors),
    );
    console.log(`[cron] collected ${totalPoints} points across ${results.length} datasets (${totalErrors} errors)`);
  } catch (error) {
    console.error('[cron] Collection failed:', error);
    metrics.push(
      Metric.create('cron_error')
        .addTag('reason', error instanceof Error ? error.name : 'unknown')
        .intField('count', 1),
    );
  }

  metrics.push(
    Metric.create('graphql_client')
      .intField('requests', graphqlClient.requestCount)
      .intField('error_responses', graphqlClient.errorResponseCount),
  );

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

async function runCollection(env: Env, metrics: CloudflareMetricsRepository, graphqlClient: CloudflareGraphQLClient) {
  const restClient = new CloudflareRestClient(env.CLOUDFLARE_API_TOKEN ?? '');
  const collector = new CloudflareMetricsCollector(graphqlClient, env.CLOUDFLARE_ACCOUNT_ID, metrics, { restClient });
  return collector.collectAll(ALL_DATASETS);
}
