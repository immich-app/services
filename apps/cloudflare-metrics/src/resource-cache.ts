import type { ICloudflareRestClient } from './cloudflare-api.js';
import { Metric } from './metric.js';
import type { CloudflareMetricsRepository } from './metrics.js';

export interface ResourceCache {
  d1Databases: Map<string, string>;
  queues: Map<string, string>;
  zones: Map<string, string>;
  // Zones from the bulk /zones list (real account zones). Zone-scoped
  // datasets only iterate this subset to avoid querying Pages project
  // zones, which would blow through the Workers subrequest limit.
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

// Module-level caches survive across isolate invocations (minutes to hours),
// avoiding redundant REST lookups on every 1-minute cron tick.
const globalZoneNameCache = new Map<string, string>();
const globalD1NameCache = new Map<string, string>();
const globalQueueNameCache = new Map<string, string>();

interface CachedResourceLookup<T> {
  values: T[];
  loadedAt: number;
}

const RESOURCE_CACHE_TTL_MS = 10 * 60 * 1000;
let cachedD1Databases: CachedResourceLookup<{ uuid: string; name: string }> | null = null;
let cachedQueues: CachedResourceLookup<{ queue_id: string; queue_name: string }> | null = null;
let cachedBulkZones: CachedResourceLookup<{ id: string; name: string }> | null = null;

// Cap per-tick individual /zones/{id} lookups to stay under the 50
// subrequest limit; the global cache absorbs the rest across ticks.
const MAX_INDIVIDUAL_ZONE_LOOKUPS_PER_RUN = 20;

export function __resetResourceCachesForTests(): void {
  globalZoneNameCache.clear();
  globalD1NameCache.clear();
  globalQueueNameCache.clear();
  cachedD1Databases = null;
  cachedQueues = null;
  cachedBulkZones = null;
}

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

  async populate(): Promise<void> {
    this.cache = emptyResourceCache();
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

    // Fall back to stale global caches when a REST lookup fails entirely,
    // so metric tags still carry names rather than being empty.
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
    const ids = [...unique].slice(0, MAX_INDIVIDUAL_ZONE_LOOKUPS_PER_RUN);
    const startedAt = performance.now();
    const restClient = this.restClient;
    const results = await Promise.allSettled(ids.map((id) => restClient.getZone(id)));
    let resolved = 0;
    let failed = 0;
    for (const [i, result] of results.entries()) {
      if (result.status === 'fulfilled' && result.value) {
        this.cache.zones.set(ids[i], result.value.name);
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
