import { beforeEach, describe, expect, it } from 'vitest';
import { __resetResourceCachesForTests, ResourceCacheService } from './resource-cache.js';
import { buildMetricsRepo, FakeRestClient, RecordingProvider, ThrowingRestClient } from './test-helpers.js';

const now = () => new Date('2026-04-10T12:00:00Z');
const laterNow = () => new Date('2026-04-10T12:30:00Z');

describe('ResourceCacheService', () => {
  let provider: RecordingProvider;
  let metrics: ReturnType<typeof buildMetricsRepo>;

  beforeEach(() => {
    provider = new RecordingProvider();
    metrics = buildMetricsRepo(provider);
    __resetResourceCachesForTests();
  });

  it('populates D1, queue, and zone caches from the rest client', async () => {
    const restClient = new FakeRestClient(
      [{ uuid: 'db-1', name: 'my-db' }],
      [{ queue_id: 'q-1', queue_name: 'my-queue' }],
      [{ id: 'zone-1', name: 'example.com' }],
    );
    const service = new ResourceCacheService('acct', metrics, now, restClient);
    await service.populate();
    const cache = service.getCache();
    expect(cache.d1Databases.get('db-1')).toBe('my-db');
    expect(cache.queues.get('q-1')).toBe('my-queue');
    expect(cache.zones.get('zone-1')).toBe('example.com');
    expect(cache.bulkZoneTags.has('zone-1')).toBe(true);
  });

  it('returns empty cache when no rest client is provided', async () => {
    const service = new ResourceCacheService('acct', metrics, now);
    await service.populate();
    const cache = service.getCache();
    expect(cache.d1Databases.size).toBe(0);
    expect(cache.queues.size).toBe(0);
    expect(cache.zones.size).toBe(0);
  });

  it('uses cached results on subsequent calls within TTL', async () => {
    let callCount = 0;
    const restClient = new FakeRestClient(
      [{ uuid: 'db-1', name: 'my-db' }],
      [],
      [],
    );
    const origList = restClient.listD1Databases.bind(restClient);
    restClient.listD1Databases = async (...args: Parameters<typeof restClient.listD1Databases>) => {
      callCount++;
      return origList(...args);
    };
    const service = new ResourceCacheService('acct', metrics, now, restClient);
    await service.populate();
    await service.populate();
    expect(callCount).toBe(1);
  });

  it('falls back to stale global cache when rest client throws', async () => {
    const restClient = new FakeRestClient(
      [{ uuid: 'db-1', name: 'my-db' }],
      [{ queue_id: 'q-1', queue_name: 'my-queue' }],
      [],
    );
    const service1 = new ResourceCacheService('acct', metrics, now, restClient);
    await service1.populate();

    // Reset per-call caches so next populate will re-fetch, then use a throwing client
    __resetResourceCachesForTests();
    // Re-seed the global caches by populating once more with good data
    const service1b = new ResourceCacheService('acct', metrics, now, restClient);
    await service1b.populate();

    // Now advance past TTL and use throwing client
    const throwingClient = new ThrowingRestClient();
    const service2 = new ResourceCacheService('acct', metrics, laterNow, throwingClient);
    await service2.populate();
    const cache = service2.getCache();
    expect(cache.d1Databases.get('db-1')).toBe('my-db');
    expect(cache.queues.get('q-1')).toBe('my-queue');
  });

  it('emits resource_lookup metrics for each resource type', async () => {
    const restClient = new FakeRestClient(
      [{ uuid: 'db-1', name: 'my-db' }],
      [],
      [{ id: 'z-1', name: 'example.com' }],
    );
    const service = new ResourceCacheService('acct', metrics, now, restClient);
    await service.populate();
    const lookups = provider.metrics.filter((m) => m.name === 'cloudflare_metrics_resource_lookup');
    expect(lookups).toHaveLength(3);
    const resources = new Set(lookups.map((m) => m.tags.get('resource')));
    expect(resources).toEqual(new Set(['d1_databases', 'queues', 'zones']));
  });

  it('emits error metrics when rest client throws', async () => {
    const throwingClient = new ThrowingRestClient();
    const service = new ResourceCacheService('acct', metrics, now, throwingClient);
    await service.populate();
    const lookups = provider.metrics.filter((m) => m.name === 'cloudflare_metrics_resource_lookup');
    for (const lookup of lookups) {
      expect(lookup.tags.get('status')).toBe('error');
    }
  });

  describe('resolveMissingZones', () => {
    it('resolves zones not in the cache via individual lookups', async () => {
      const restClient = new FakeRestClient([], [], [], {
        'zone-new': { id: 'zone-new', name: 'new.example.com' },
      });
      const service = new ResourceCacheService('acct', metrics, now, restClient);
      await service.populate();
      await service.resolveMissingZones(['zone-new']);
      expect(service.getCache().zones.get('zone-new')).toBe('new.example.com');
    });

    it('skips zones already in cache', async () => {
      const restClient = new FakeRestClient([], [], [{ id: 'zone-1', name: 'example.com' }]);
      const service = new ResourceCacheService('acct', metrics, now, restClient);
      await service.populate();
      await service.resolveMissingZones(['zone-1']);
      expect(restClient.getZoneCalls).toHaveLength(0);
    });

    it('caps individual lookups per run', async () => {
      const zones: Record<string, { id: string; name: string }> = {};
      for (let i = 0; i < 25; i++) {
        zones[`z-${i}`] = { id: `z-${i}`, name: `zone${i}.com` };
      }
      const restClient = new FakeRestClient([], [], [], zones);
      const service = new ResourceCacheService('acct', metrics, now, restClient);
      await service.populate();
      await service.resolveMissingZones(Object.keys(zones));
      expect(restClient.getZoneCalls).toHaveLength(20);
    });

    it('does nothing when no rest client is provided', async () => {
      const service = new ResourceCacheService('acct', metrics, now);
      await service.populate();
      await service.resolveMissingZones(['zone-1']);
      expect(service.getCache().zones.size).toBe(0);
    });

    it('emits lookup metrics with partial status on failures', async () => {
      const restClient = new FakeRestClient([], [], [], {
        'zone-ok': { id: 'zone-ok', name: 'ok.com' },
      });
      const origGetZone = restClient.getZone.bind(restClient);
      restClient.getZone = async (id: string) => {
        if (id === 'zone-fail') {
          throw new Error('network error');
        }
        return origGetZone(id);
      };
      const service = new ResourceCacheService('acct', metrics, now, restClient);
      await service.populate();
      await service.resolveMissingZones(['zone-ok', 'zone-fail']);
      const lookup = provider.metrics.find(
        (m) => m.name === 'cloudflare_metrics_resource_lookup' && m.tags.get('resource') === 'zones_individual',
      );
      expect(lookup?.tags.get('status')).toBe('partial');
      expect(lookup?.fields.get('resolved')).toEqual({ value: 1, type: 'int' });
      expect(lookup?.fields.get('failed')).toEqual({ value: 1, type: 'int' });
    });
  });
});
