import type { DeferredRepository } from './deferred.js';
import type { IGitHubRepository } from './github-repository.js';
import { MemoryCache } from './memory-cache.js';
import { type IMetricsRepository, Metric } from './metrics.js';
import type { IReleaseRepository } from './release-repository.js';
import type { ChangelogResponse, GitHubRelease, VersionResponse } from './types.js';
import { parseSemVer } from './version.js';

const VERSION_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// Module-level state - persists across requests within the same isolate
export const versionCache = new MemoryCache<VersionResponse>(VERSION_CACHE_TTL_MS);
export const revalidationState = { inFlight: false };

export class VersionService {
  constructor(
    private releaseRepository: IReleaseRepository,
    private metrics: IMetricsRepository,
  ) {}

  async getLatestVersion(deferred: DeferredRepository): Promise<VersionResponse | null> {
    const cached = versionCache.get();

    if (cached && !cached.stale) {
      this.metrics.push(Metric.create('memory_cache_hit').intField('count', 1));
      return cached.value;
    }

    if (cached?.stale) {
      this.metrics.push(Metric.create('memory_cache_stale').intField('count', 1));
      if (!revalidationState.inFlight) {
        revalidationState.inFlight = true;
        deferred.defer(async () => {
          try {
            await this.refreshVersionCache();
          } finally {
            revalidationState.inFlight = false;
          }
        });
      }
      return cached.value;
    }

    this.metrics.push(Metric.create('memory_cache_miss').intField('count', 1));
    return this.refreshVersionCache();
  }

  private async refreshVersionCache(): Promise<VersionResponse | null> {
    const latest = await this.metrics.monitorAsyncFunction({ name: 'd1_get_latest' }, () =>
      this.releaseRepository.getLatest(),
    )();

    if (!latest) {
      return null;
    }

    const response: VersionResponse = { version: latest.tag_name, published_at: latest.published_at };
    versionCache.set(response);
    return response;
  }

  async getChangelog(version: string): Promise<ChangelogResponse> {
    const semver = parseSemVer(version);
    if (!semver) {
      throw new Error('Invalid version');
    }

    const [newerReleases, latest] = await this.metrics.monitorAsyncFunction({ name: 'd1_get_changelog' }, () =>
      Promise.all([this.releaseRepository.getNewerThan(semver), this.releaseRepository.getLatest()]),
    )();

    return { current: version, latest, releases: newerReleases };
  }

  async handleReleasePublished(release: GitHubRelease): Promise<void> {
    await this.metrics.monitorAsyncFunction({ name: 'webhook_upsert' }, () => this.releaseRepository.upsert(release))();
    this.metrics.push(Metric.create('webhook_release_upserted').addTag('tag', release.tag_name).intField('count', 1));
    versionCache.invalidate();
    await this.emitLatestVersion();
    await this.emitReleaseCount();
  }

  async syncFromGitHub(githubRepository: IGitHubRepository): Promise<{ synced: number; full: boolean }> {
    const latest = await this.metrics.monitorAsyncFunction({ name: 'github_fetch_latest' }, () =>
      githubRepository.fetchLatestRelease(),
    )();

    if (!latest) {
      return { synced: 0, full: false };
    }

    const stored = await this.releaseRepository.getLatest();
    const isNewRelease = !stored || stored.tag_name !== latest.tag_name;
    const isUpdated = stored?.tag_name === latest.tag_name && stored.body !== latest.body;

    if (isUpdated) {
      await this.metrics.monitorAsyncFunction({ name: 'd1_upsert' }, () => this.releaseRepository.upsert(latest))();
      this.metrics.push(Metric.create('cron_release_updated').addTag('tag', latest.tag_name).intField('count', 1));
      versionCache.invalidate();
      await this.emitReleaseCount();
      return { synced: 1, full: false };
    }

    if (isNewRelease) {
      const releases = await this.metrics.monitorAsyncFunction({ name: 'github_fetch_all' }, () =>
        githubRepository.fetchReleases(),
      )();
      await this.metrics.monitorAsyncFunction({ name: 'd1_bulk_upsert' }, () =>
        this.releaseRepository.bulkUpsert(releases),
      )();
      this.metrics.push(Metric.create('cron_releases_synced').intField('count', releases.length));
      versionCache.invalidate();
      await this.emitReleaseCount();
      return { synced: releases.length, full: true };
    }

    await this.emitReleaseCount();
    return { synced: 0, full: false };
  }

  async fullSync(githubRepository: IGitHubRepository): Promise<number> {
    const releases = await this.metrics.monitorAsyncFunction({ name: 'github_fetch_all' }, () =>
      githubRepository.fetchReleases(),
    )();

    await this.metrics.monitorAsyncFunction({ name: 'd1_bulk_upsert' }, () =>
      this.releaseRepository.bulkUpsert(releases),
    )();

    this.metrics.push(Metric.create('cron_full_sync').intField('count', releases.length));
    versionCache.invalidate();
    await this.emitReleaseCount();
    return releases.length;
  }

  async emitLatestVersion(): Promise<void> {
    const latest = await this.releaseRepository.getLatest();
    if (latest) {
      const version = latest.tag_name.replace(/^v/, '');
      this.metrics.push(
        Metric.create('latest_version')
          .addTag('version', version)
          .addTag('user_agent', `immich-server/${version}`)
          .intField('count', 1),
      );
    }
  }

  private async emitReleaseCount(): Promise<void> {
    const count = await this.releaseRepository.getCount();
    this.metrics.push(Metric.create('d1_release_count').intField('count', count));
  }
}
