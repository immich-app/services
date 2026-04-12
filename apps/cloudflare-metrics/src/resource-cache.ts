import type { ICloudflareRestClient } from './cloudflare-api.js';
import { Metric } from './metric.js';
import type { CloudflareMetricsRepository } from './metrics.js';

/**
 * Shared lookup cache for resources that aren't exposed via GraphQL
 * dimensions (D1 databases, queues, zones). Populated from the REST API
 * at the start of each cron tick and consulted by the emitter to enrich
 * metric tags with human-readable names.
 */
export interface ResourceCache {
  d1Databases: Map<string, string>;
  queues: Map<string, string>;
  /** All known zones: bulk list + lazily-resolved Pages projects. */
  zones: Map<string, string>;
  /**
   * Zones that came from the bulk `/zones?account.id=` list, i.e. real
   * account-owned zones. Zone-scoped datasets only iterate this subset to
   * avoid running per-zone queries against the dozens of Pages project
   * zones (which would blow through the Workers subrequest limit).
   */
  bulkZoneTags: Set<string>;
}

export function emptyResourceCache(): ResourceCache {
  return {
    d1Databases: new Map(),
    queues: new Map(),
    zones: new Map(),
    bulkZoneTags: new Set(),
  };
}

/**
 * Module-level caches persisted across Worker isolate invocations.
 * Cloudflare Workers isolates stay warm for several minutes to hours, so
 * these let us skip REST lookups that would otherwise run every cron tick
 * — which matters a lot at 1-minute cron frequency where we want every
 * invocation to be as cheap as possible. Caches reset when the isolate
 * is recycled; that's the effective TTL.
 */
const globalZoneNameCache = new Map<string, string>();
const globalD1NameCache = new Map<string, string>();
const globalQueueNameCache = new Map<string, string>();

interface CachedResourceLookup<T> {
  values: T[];
  loadedAt: number;
}

/**
 * Cache for the full bulk-list responses, keyed by kind. We re-fetch if
 * the cache is older than `RESOURCE_CACHE_TTL_MS` or empty. Keeping the
 * full list (not just id→name) lets us seed the per-cron `ResourceCache`
 * cleanly in `populateResourceCache`.
 */
const RESOURCE_CACHE_TTL_MS = 10 * 60 * 1000;
let cachedD1Databases: CachedResourceLookup<{ uuid: string; name: string }> | null = null;
let cachedQueues: CachedResourceLookup<{ queue_id: string; queue_name: string }> | null = null;
let cachedBulkZones: CachedResourceLookup<{ id: string; name: string }> | null = null;

/**
 * Upper bound on individual `/zones/{id}` lookups per cron tick. Each
 * lookup is one subrequest, and Cloudflare Workers caps subrequests at
 * 50/invocation. Batching the GraphQL queries frees up most of the
 * budget, but keeping a safety cap here means a one-off spike of new
 * Pages projects can't still blow us over. The `globalZoneNameCache`
 * absorbs the rest over the next couple of ticks.
 */
const MAX_INDIVIDUAL_ZONE_LOOKUPS_PER_RUN = 20;

/**
 * Resets all module-level caches. Intended for unit tests so each test
 * gets a fresh view of the rest client; has no use in production code.
 */
export function __resetResourceCachesForTests(): void {
  globalZoneNameCache.clear();
  globalD1NameCache.clear();
  globalQueueNameCache.clear();
  cachedD1Databases = null;
  cachedQueues = null;
  cachedBulkZones = null;
}

/**
 * Service that owns the per-tick `ResourceCache` and handles both the
 * bulk population (via `populate()`) and the lazy per-zoneTag resolution
 * for Pages project zones (via `resolveMissingZones()`).
 */
export class ResourceCacheService {
  private cache: ResourceCache = emptyResourceCache();

  constructor(
    private readonly accountTag: string,
    private readonly metrics: CloudflareMetricsRepository,
    private readonly now: () => Date,
    private readonly restClient?: ICloudflareRestClient,
  ) {}

  getCache(): ResourceCache {
    return this.cache;
  }

  /**
   * Seed the cache for this cron tick: reset it, fill zones from the
   * module-level lazy cache, and fetch the bulk D1/queue/zone lists
   * through the REST client (respecting the 10-minute TTL).
   */
  async populate(): Promise<void> {
    this.cache = emptyResourceCache();
    // Seed lazily-resolved zone names (Pages projects) from the module-level
    // cache populated in previous invocations — these rarely change.
    for (const [tag, name] of globalZoneNameCache) {
      this.cache.zones.set(tag, name);
    }
    if (!this.restClient) {
      return;
    }

    const restClient = this.restClient;
    const now = this.now().getTime();
    const cacheFresh = <T>(cache: CachedResourceLookup<T> | null): cache is CachedResourceLookup<T> =>
      cache !== null && now - cache.loadedAt < RESOURCE_CACHE_TTL_MS;

    // Use cached bulk responses when fresh, otherwise re-fetch. Each refresh
    // saves 1 subrequest / lookup between calls — meaningful at 1-minute
    // cron frequency.
    const [d1Result, queuesResult, zonesResult] = await Promise.allSettled([
      cacheFresh(cachedD1Databases)
        ? Promise.resolve(cachedD1Databases.values)
        : restClient.listD1Databases(this.accountTag).then((values) => {
            cachedD1Databases = { values, loadedAt: now };
            return values;
          }),
      cacheFresh(cachedQueues)
        ? Promise.resolve(cachedQueues.values)
        : restClient.listQueues(this.accountTag).then((values) => {
            cachedQueues = { values, loadedAt: now };
            return values;
          }),
      cacheFresh(cachedBulkZones)
        ? Promise.resolve(cachedBulkZones.values)
        : restClient.listZones(this.accountTag).then((values) => {
            cachedBulkZones = { values, loadedAt: now };
            return values;
          }),
    ]);

    this.recordResourceLookup('d1_databases', d1Result, (items) => {
      for (const db of items) {
        if (db.uuid && db.name) {
          this.cache.d1Databases.set(db.uuid, db.name);
          globalD1NameCache.set(db.uuid, db.name);
        }
      }
    });
    this.recordResourceLookup('queues', queuesResult, (items) => {
      for (const q of items) {
        if (q.queue_id && q.queue_name) {
          this.cache.queues.set(q.queue_id, q.queue_name);
          globalQueueNameCache.set(q.queue_id, q.queue_name);
        }
      }
    });
    this.recordResourceLookup('zones', zonesResult, (items) => {
      for (const z of items) {
        if (z.id && z.name) {
          this.cache.zones.set(z.id, z.name);
          this.cache.bulkZoneTags.add(z.id);
        }
      }
    });

    // If a REST lookup failed entirely (no cache yet and fetch rejected),
    // fall back to whatever id→name pairs survived from previous isolate
    // invocations via the global caches. Better to emit stale-but-present
    // name tags than empty ones.
    if (d1Result.status === 'rejected') {
      for (const [uuid, name] of globalD1NameCache) {
        this.cache.d1Databases.set(uuid, name);
      }
    }
    if (queuesResult.status === 'rejected') {
      for (const [id, name] of globalQueueNameCache) {
        this.cache.queues.set(id, name);
      }
    }
  }

  /**
   * Fetches any zone ids that aren't already in the cache individually via
   * `/zones/{id}` and adds them. Used to cover Cloudflare Pages project zones
   * (and any other zones that don't show up in the bulk `/zones` listing).
   * Failures are tolerated — missing zones will fall back to their zoneTag in
   * the metric label.
   */
  async resolveMissingZones(missingTags: Iterable<string>): Promise<void> {
    if (!this.restClient) {
      return;
    }
    const unique = new Set<string>();
    for (const tag of missingTags) {
      if (tag && !this.cache.zones.has(tag)) {
        unique.add(tag);
      }
    }
    if (unique.size === 0) {
      return;
    }
    // Throttle the number of lookups per invocation so cold starts don't
    // exceed the 50-subrequest limit. The module-level cache will absorb
    // the rest across the next few cron ticks.
    const ids = [...unique].slice(0, MAX_INDIVIDUAL_ZONE_LOOKUPS_PER_RUN);
    const startedAt = performance.now();
    const restClient = this.restClient;
    const results = await Promise.allSettled(ids.map((id) => restClient.getZone(id)));
    let resolved = 0;
    let failed = 0;
    for (const [i, result] of results.entries()) {
      if (result.status === 'fulfilled' && result.value) {
        this.cache.zones.set(ids[i], result.value.name);
        // Persist in the module-level cache so the next isolate invocation
        // skips the lookup.
        globalZoneNameCache.set(ids[i], result.value.name);
        resolved++;
      } else if (result.status === 'rejected') {
        failed++;
      }
    }
    this.metrics.push(
      Metric.create('resource_lookup')
        .addTag('resource', 'zones_individual')
        .addTag('status', failed > 0 ? 'partial' : 'success')
        .intField('requested', ids.length)
        .intField('resolved', resolved)
        .intField('failed', failed)
        .durationField('duration', performance.now() - startedAt),
    );
  }

  private recordResourceLookup<T>(
    resource: string,
    result: PromiseSettledResult<T[]>,
    onSuccess: (items: T[]) => void,
  ): void {
    if (result.status === 'fulfilled') {
      onSuccess(result.value);
      this.metrics.push(
        Metric.create('resource_lookup')
          .addTag('resource', resource)
          .addTag('status', 'success')
          .intField('count', result.value.length),
      );
    } else {
      console.error(`[collector] resource lookup ${resource} failed:`, errorMessage(result.reason));
      this.metrics.push(
        Metric.create('resource_lookup')
          .addTag('resource', resource)
          .addTag('status', 'error')
          .addTag('error', errorTag(result.reason))
          .intField('errors', 1),
      );
    }
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function errorTag(error: unknown): string {
  if (error instanceof Error) {
    return error.name;
  }
  return 'unknown';
}
