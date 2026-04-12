import { DeferredRepository } from '../deferred.js';
import { HeaderMetricsProvider, InfluxMetricsProvider } from '../metric-providers.js';
import { Metric } from '../metric.js';
import { CloudflareMetricsRepository } from '../metrics.js';

/**
 * HTTP handler for the cloudflare-metrics worker. Currently only exposes
 * `/health` for smoke testing; the actual collection runs under the
 * scheduled handler. This module stays small on purpose — any new
 * endpoint should be added as its own handler function and dispatched
 * from `handleFetch` below.
 */
export async function handleFetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
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
    const response = await metrics.monitorAsyncFunction({ name: 'handle_request' }, () => routeRequest(request))();

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
}

function routeRequest(request: Request): Promise<Response> {
  const url = new URL(request.url);

  if (request.method === 'OPTIONS') {
    return Promise.resolve(
      new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
          'Access-Control-Max-Age': '86400',
        },
      }),
    );
  }

  switch (url.pathname) {
    case '/health': {
      return Promise.resolve(jsonResponse({ status: 'ok' }));
    }

    default: {
      return Promise.resolve(errorResponse('Not Found', 404));
    }
  }
}

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
