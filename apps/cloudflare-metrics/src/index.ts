import { CloudflareRestClient } from './cloudflare-api.js';
import { CloudflareMetricsCollector } from './collector.js';
import { ALL_DATASETS } from './datasets.js';
import { DeferredRepository } from './deferred.js';
import { CloudflareGraphQLClient } from './graphql-client.js';
import {
  CloudflareMetricsRepository,
  HeaderMetricsProvider,
  InfluxMetricsProvider,
  Metric,
  takeLastFlushStats,
} from './metrics.js';

const DEFAULT_HEADERS: Record<string, string> = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
};

function jsonResponse(data: unknown, status = 200, extraHeaders: Record<string, string> = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...DEFAULT_HEADERS, ...extraHeaders },
  });
}

function errorResponse(error: string, status: number) {
  return jsonResponse({ error }, status);
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const deferredRepository = new DeferredRepository(ctx);
    const headerProvider = new HeaderMetricsProvider();
    const influxProvider = new InfluxMetricsProvider(env.VMETRICS_API_TOKEN ?? '', env.ENVIRONMENT ?? '');
    deferredRepository.defer(() => influxProvider.flush());
    const metrics = new CloudflareMetricsRepository(
      'cloudflare_metrics',
      request,
      [influxProvider, headerProvider],
      env.ENVIRONMENT ?? '',
    );

    try {
      const response = await metrics.monitorAsyncFunction({ name: 'handle_request' }, async () => {
        const url = new URL(request.url);

        if (request.method === 'OPTIONS') {
          return new Response(null, {
            headers: {
              'Access-Control-Allow-Origin': '*',
              'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
              'Access-Control-Allow-Headers': 'Content-Type',
              'Access-Control-Max-Age': '86400',
            },
          });
        }

        switch (url.pathname) {
          case '/health': {
            return jsonResponse({ status: 'ok' });
          }

          case '/collect': {
            // Manual trigger for debugging. Gated on having both tokens
            // configured so it is effectively a no-op in local development
            // without credentials.
            if (!env.CLOUDFLARE_API_TOKEN || !env.CLOUDFLARE_ACCOUNT_ID) {
              return errorResponse('Collector not configured', 503);
            }
            const graphqlClient = new CloudflareGraphQLClient(env.CLOUDFLARE_API_TOKEN);
            const results = await runCollection(env, metrics, graphqlClient);
            return jsonResponse({ results });
          }

          default: {
            return errorResponse('Not Found', 404);
          }
        }
      })();

      const url = new URL(request.url);
      metrics.push(
        Metric.create('http_response')
          .addTag('method', request.method)
          .addTag('path', url.pathname)
          .addTag('status', String(response.status))
          .intField('count', 1),
      );

      response.headers.set('Server-Timing', headerProvider.getTimingHeader());
      deferredRepository.runDeferred();
      return response;
    } catch (error) {
      console.error(error);
      metrics.push(
        Metric.create('http_response')
          .addTag('method', request.method)
          .addTag('path', new URL(request.url).pathname)
          .addTag('status', '500')
          .intField('count', 1),
      );
      deferredRepository.runDeferred();
      return errorResponse('Internal Server Error', 500);
    }
  },

  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
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
  },
};

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
