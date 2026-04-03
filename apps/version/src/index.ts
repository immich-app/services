import { DeferredRepository } from './deferred.js';
import { createInstallationToken } from './github-auth.js';
import { GitHubRepository } from './github-repository.js';
import { CloudflareMetricsRepository, HeaderMetricsProvider, InfluxMetricsProvider, Metric } from './metrics.js';
import { ReleaseRepository } from './release-repository.js';
import type { GitHubRelease } from './types.js';
import { VersionService } from './version-service.js';
import { parseSemVer } from './version.js';
import { verifyWebhookSignature } from './webhook.js';

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

function errorResponse(error: string, status: number, extraHeaders?: Record<string, string>) {
  return jsonResponse({ error }, status, extraHeaders);
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const deferredRepository = new DeferredRepository(ctx);
    const headerProvider = new HeaderMetricsProvider();
    const influxProvider = new InfluxMetricsProvider(env.VMETRICS_API_TOKEN ?? '', env.ENVIRONMENT ?? '');
    deferredRepository.defer(() => influxProvider.flush());
    const metrics = new CloudflareMetricsRepository(
      'version',
      request,
      [influxProvider, headerProvider],
      env.ENVIRONMENT ?? '',
    );

    const releaseRepository = new ReleaseRepository(env.VERSION_DB);
    const versionService = new VersionService(releaseRepository, metrics);

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

          case '/version': {
            return await metrics.monitorAsyncFunction(
              {
                name: 'version_request',
                tags: {
                  client_ip: request.headers.get('CF-Connecting-IP') ?? '',
                  user_agent: request.headers.get('User-Agent') ?? '',
                },
              },
              async (): Promise<Response> => {
                const latest = await versionService.getLatestVersion();
                if (!latest) {
                  return errorResponse('No releases found', 404);
                }
                return jsonResponse(latest);
              },
            )();
          }

          case '/changelog': {
            const version = url.searchParams.get('version');
            if (!version) {
              return errorResponse('Missing required query parameter: version', 400);
            }

            if (!parseSemVer(version)) {
              return errorResponse('Invalid version format. Expected semver (e.g., 1.100.0 or v1.100.0)', 400);
            }

            const requestTags = {
              version,
              client_ip: request.headers.get('CF-Connecting-IP') ?? '',
              user_agent: request.headers.get('User-Agent') ?? '',
            };

            if (env.ENVIRONMENT) {
              const cache = caches.default;
              const cacheKey = new Request(url.toString(), request);
              const cached = await cache.match(cacheKey);

              if (cached) {
                metrics.push(
                  Metric.create('changelog_request')
                    .addTags(requestTags)
                    .addTag('cache', 'cdn')
                    .intField('invocation', 1),
                );
                return new Response(cached.body, cached);
              }
            }

            return await metrics.monitorAsyncFunction(
              { name: 'changelog_request', tags: requestTags },
              async (): Promise<Response> => {
                const changelog = await versionService.getChangelog(version);
                const response = jsonResponse(changelog, 200, { 'Cache-Control': 'public, max-age=86400' });
                if (env.ENVIRONMENT) {
                  const cache = caches.default;
                  const cacheKey = new Request(url.toString(), request);
                  ctx.waitUntil(cache.put(cacheKey, response.clone()));
                }
                return response;
              },
            )();
          }

          case '/webhook': {
            if (request.method !== 'POST') {
              return errorResponse('Method Not Allowed', 405);
            }

            const signature = request.headers.get('X-Hub-Signature-256');
            if (!signature || !env.GITHUB_WEBHOOK_SECRET) {
              return errorResponse('Unauthorized', 401);
            }

            const body = await request.text();
            const isValid = await verifyWebhookSignature(body, signature, env.GITHUB_WEBHOOK_SECRET);
            if (!isValid) {
              return errorResponse('Unauthorized', 401);
            }

            metrics.push(
              Metric.create('webhook_received')
                .addTag('event', request.headers.get('X-GitHub-Event') ?? 'unknown')
                .intField('count', 1),
            );

            const event = request.headers.get('X-GitHub-Event');
            if (event !== 'release') {
              return jsonResponse({ ignored: true });
            }

            const payload = JSON.parse(body);
            if (payload.action !== 'published') {
              return jsonResponse({ ignored: true });
            }

            const releaseData = payload.release;
            if (!releaseData?.id || !releaseData?.tag_name) {
              return errorResponse('Invalid release payload', 400);
            }

            if (releaseData.draft || releaseData.prerelease) {
              return jsonResponse({ ignored: true });
            }

            const release: GitHubRelease = {
              id: releaseData.id,
              tag_name: releaseData.tag_name,
              name: String(releaseData.name ?? ''),
              url: String(releaseData.url ?? ''),
              body: String(releaseData.body ?? ''),
              created_at: String(releaseData.created_at ?? ''),
              published_at: String(releaseData.published_at ?? ''),
            };

            await versionService.handleReleasePublished(release);
            return jsonResponse({ success: true });
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
          .addTag('error', error instanceof Error ? error.message : 'unknown')
          .intField('count', 1),
      );
      deferredRepository.runDeferred();
      return errorResponse('Internal Server Error', 500);
    }
  },

  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    const influxProvider = new InfluxMetricsProvider(env.VMETRICS_API_TOKEN ?? '', env.ENVIRONMENT ?? '');
    const request = new Request('https://localhost/cron');
    const metrics = new CloudflareMetricsRepository('version', request, [influxProvider], env.ENVIRONMENT ?? '');

    let githubToken: string | undefined;
    if (env.GITHUB_APP_ID && env.GITHUB_APP_PRIVATE_KEY && env.GITHUB_APP_INSTALLATION_ID) {
      githubToken = await createInstallationToken({
        appId: env.GITHUB_APP_ID,
        privateKey: env.GITHUB_APP_PRIVATE_KEY,
        installationId: Number(env.GITHUB_APP_INSTALLATION_ID),
      });
    }

    const githubRepository = new GitHubRepository(githubToken);
    const releaseRepository = new ReleaseRepository(env.VERSION_DB);
    const versionService = new VersionService(releaseRepository, metrics);
    const isNightly = event.cron === '0 3 * * *';

    try {
      if (isNightly) {
        const count = await metrics.monitorAsyncFunction({ name: 'cron_full_sync' }, () =>
          versionService.fullSync(githubRepository),
        )();
        console.log(`[cron] Nightly full sync: ${count} releases`);
      } else {
        const result = await metrics.monitorAsyncFunction({ name: 'cron_sync' }, () =>
          versionService.syncFromGitHub(githubRepository),
        )();
        console.log(`[cron] Synced ${result.synced} releases (full=${result.full})`);
      }
    } catch (error) {
      console.error('[cron] Sync failed:', error);
      metrics.push(
        Metric.create('cron_error')
          .addTag('error', error instanceof Error ? error.message : 'unknown')
          .intField('count', 1),
      );
    }

    // Always emit release count and latest version, even if sync failed
    try {
      const releaseCount = await releaseRepository.getCount();
      metrics.push(Metric.create('d1_release_count').intField('count', releaseCount));
      await versionService.emitLatestVersion();
    } catch {
      // D1 might not be initialized yet
    }

    ctx.waitUntil(influxProvider.flush());
  },
};
