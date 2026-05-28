import { env, exports } from 'cloudflare:workers';
import semver from 'semver';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryCache } from './memory-cache.js';
import { revalidationState, versionCache } from './version-service.js';
import { verifyWebhookSignature } from './webhook.js';

async function createSchema() {
  await env.VERSION_DB.prepare(
    "CREATE TABLE IF NOT EXISTS releases (id INTEGER PRIMARY KEY, tag_name TEXT NOT NULL UNIQUE, name TEXT NOT NULL DEFAULT '', url TEXT NOT NULL DEFAULT '', body TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT '', published_at TEXT NOT NULL DEFAULT '', major INTEGER NOT NULL, minor INTEGER NOT NULL, patch INTEGER NOT NULL, prerelease INTEGER)",
  ).run();
  await env.VERSION_DB.prepare(
    'CREATE INDEX IF NOT EXISTS idx_releases_semver ON releases (major DESC, minor DESC, patch DESC)',
  ).run();
}

const mockReleases = [
  {
    id: 3,
    tag_name: 'v1.120.0',
    name: 'v1.120.0',
    url: 'https://api.github.com/repos/immich-app/immich/releases/3',
    created_at: '2025-03-01T00:00:00Z',
    published_at: '2025-03-01T00:00:00Z',
    body: '## Changes in v1.120.0\n- Feature C',
  },
  {
    id: 2,
    tag_name: 'v1.110.0',
    name: 'v1.110.0',
    url: 'https://api.github.com/repos/immich-app/immich/releases/2',
    created_at: '2025-02-01T00:00:00Z',
    published_at: '2025-02-01T00:00:00Z',
    body: '## Changes in v1.110.0\n- Feature B',
  },
  {
    id: 1,
    tag_name: 'v1.100.0',
    name: 'v1.100.0',
    url: 'https://api.github.com/repos/immich-app/immich/releases/1',
    created_at: '2025-01-01T00:00:00Z',
    published_at: '2025-01-01T00:00:00Z',
    body: '## Changes in v1.100.0\n- Feature A',
  },
];

interface SeedRelease {
  id: number;
  tag_name: string;
  name?: string;
  url?: string;
  body?: string;
  created_at?: string;
  published_at?: string;
}

async function insertRelease(release: SeedRelease) {
  const parsedVersion = semver.parse(release.tag_name)!;
  await env.VERSION_DB.prepare(
    `INSERT OR REPLACE INTO releases (id, tag_name, name, url, body, created_at, published_at, major, minor, patch, prerelease)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      release.id,
      release.tag_name,
      release.name ?? release.tag_name,
      release.url ?? '',
      release.body ?? '',
      release.created_at ?? '',
      release.published_at ?? '',
      parsedVersion.major,
      parsedVersion.minor,
      parsedVersion.patch,
      parsedVersion.prerelease[1] ?? null,
    )
    .run();
}

async function seedReleases() {
  for (const release of mockReleases) {
    await insertRelease(release);
  }
}

async function createWebhookSignature(body: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  const hex = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `sha256=${hex}`;
}

describe('MemoryCache', () => {
  it('returns null when empty', () => {
    const cache = new MemoryCache<string>(1000);
    expect(cache.get()).toBeNull();
  });

  it('stores and retrieves a fresh value', () => {
    const cache = new MemoryCache<string>(1000);
    cache.set('hello');
    const result = cache.get();
    expect(result).not.toBeNull();
    expect(result!.value).toBe('hello');
    expect(result!.stale).toBe(false);
  });

  it('returns stale after TTL expires', () => {
    const cache = new MemoryCache<string>(0); // 0ms TTL = immediately stale
    cache.set('hello');
    const result = cache.get();
    expect(result).not.toBeNull();
    expect(result!.value).toBe('hello');
    expect(result!.stale).toBe(true);
  });

  it('invalidates the cache', () => {
    const cache = new MemoryCache<string>(1000);
    cache.set('hello');
    cache.invalidate();
    expect(cache.get()).toBeNull();
  });
});

describe('Webhook signature verification', () => {
  it('verifies a valid signature', async () => {
    const body = 'test body';
    const secret = 'test-secret';
    const signature = await createWebhookSignature(body, secret);
    expect(await verifyWebhookSignature(body, signature, secret)).toBe(true);
  });

  it('rejects an invalid signature', async () => {
    expect(await verifyWebhookSignature('body', 'sha256=invalid', 'secret')).toBe(false);
  });

  it('rejects a signature without sha256 prefix', async () => {
    expect(await verifyWebhookSignature('body', 'md5=abc', 'secret')).toBe(false);
  });

  it('rejects when body is tampered', async () => {
    const signature = await createWebhookSignature('original', 'secret');
    expect(await verifyWebhookSignature('tampered', signature, 'secret')).toBe(false);
  });
});

describe('Version Worker', () => {
  beforeAll(async () => {
    await createSchema();
  });

  beforeEach(async () => {
    versionCache.invalidate();
    revalidationState.inFlight = false;
    await env.VERSION_DB.exec('DELETE FROM releases');
    await seedReleases();
  });

  describe('OPTIONS preflight', () => {
    it('returns correct CORS headers', async () => {
      const response = await exports.default.fetch('https://example.com/version', { method: 'OPTIONS' });
      expect(response.status).toBe(200);
      expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
      expect(response.headers.get('Access-Control-Allow-Methods')).toBe('GET, POST, OPTIONS');
      expect(response.headers.get('Access-Control-Allow-Headers')).toBe('Content-Type');
      expect(response.headers.get('Access-Control-Max-Age')).toBe('86400');
    });
  });

  describe('GET /health', () => {
    it('returns healthy status', async () => {
      const response = await exports.default.fetch('https://example.com/health');
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toEqual({ status: 'ok' });
    });
  });

  describe('GET /version', () => {
    it('returns the latest version', async () => {
      const response = await exports.default.fetch('https://example.com/version');
      expect(response.status).toBe(200);
      const body = (await response.json()) as any;
      expect(body.version).toBe('v1.120.0');
      expect(body.published_at).toBe('2025-03-01T00:00:00Z');
    });

    it('returns the latest stable version, ignoring newer pre-releases', async () => {
      // A pre-release newer than every stable release must not be served on the default (stable) channel.
      await insertRelease({ id: 10, tag_name: 'v1.130.0-rc.1', published_at: '2025-04-01T00:00:00Z' });
      versionCache.invalidate();

      const response = await exports.default.fetch('https://example.com/version');
      expect(response.status).toBe(200);
      const body = (await response.json()) as any;
      expect(body.version).toBe('v1.120.0');
    });

    it('awaits D1 on cold start rather than deferring', async () => {
      // Cache is empty (invalidated in beforeEach), D1 has data
      // The first request must return real data, not 404 or empty
      const response = await exports.default.fetch('https://example.com/version');
      expect(response.status).toBe(200);
      const body = (await response.json()) as any;
      expect(body.version).toBe('v1.120.0');

      // Now delete D1 data — second request should come from cache, proving
      // the first request populated the cache synchronously
      await env.VERSION_DB.exec('DELETE FROM releases');
      const second = await exports.default.fetch('https://example.com/version');
      expect(second.status).toBe(200);
      const secondBody = (await second.json()) as any;
      expect(secondBody.version).toBe('v1.120.0');
    });

    it('does not include Cache-Control header (memory cached, not CDN)', async () => {
      const response = await exports.default.fetch('https://example.com/version');
      expect(response.headers.get('Cache-Control')).toBeNull();
    });

    it('returns 404 when no releases exist', async () => {
      await env.VERSION_DB.exec('DELETE FROM releases');
      const response = await exports.default.fetch('https://example.com/version');
      expect(response.status).toBe(404);
    });

    it('serves from in-memory cache on second request', async () => {
      const first = await exports.default.fetch('https://example.com/version');
      expect(first.status).toBe(200);

      // Delete from D1 - second request should still work from cache
      await env.VERSION_DB.exec('DELETE FROM releases');

      const second = await exports.default.fetch('https://example.com/version');
      expect(second.status).toBe(200);
      const body = (await second.json()) as any;
      expect(body.version).toBe('v1.120.0');
    });

    it('includes CORS header', async () => {
      const response = await exports.default.fetch('https://example.com/version');
      expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
    });

    it('serves stale data while revalidating in the background', async () => {
      // Prime the cache
      const first = await exports.default.fetch('https://example.com/version');
      expect(first.status).toBe(200);

      // Expire the cache by invalidating and setting with 0 TTL
      versionCache.invalidate();
      versionCache.set({ version: 'v1.120.0', published_at: '2025-03-01T00:00:00Z' });
      // Manually expire it
      Object.assign(versionCache, { expiresAt: 0 });

      // Update D1 with a new version
      await insertRelease({
        id: 4,
        tag_name: 'v1.130.0',
        created_at: '2025-04-01T00:00:00Z',
        published_at: '2025-04-01T00:00:00Z',
      });

      // This request should get stale v1.120.0 while triggering background refresh
      const stale = await exports.default.fetch('https://example.com/version');
      expect(stale.status).toBe(200);
      const staleBody = (await stale.json()) as any;
      expect(staleBody.version).toBe('v1.120.0');

      // Wait for background refresh to complete
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Next request should get the updated version from refreshed cache
      const fresh = await exports.default.fetch('https://example.com/version');
      expect(fresh.status).toBe(200);
      const freshBody = (await fresh.json()) as any;
      expect(freshBody.version).toBe('v1.130.0');
    });

    it('deduplicates concurrent revalidation requests', async () => {
      // Set up stale cache
      versionCache.set({ version: 'v1.120.0', published_at: '2025-03-01T00:00:00Z' });
      Object.assign(versionCache, { expiresAt: 0 });

      expect(revalidationState.inFlight).toBe(false);

      // Fire two concurrent requests while stale
      const [r1, r2] = await Promise.all([
        exports.default.fetch('https://example.com/version'),
        exports.default.fetch('https://example.com/version'),
      ]);

      expect(r1.status).toBe(200);
      expect(r2.status).toBe(200);

      // Both should return stale data immediately
      const b1 = (await r1.json()) as any;
      const b2 = (await r2.json()) as any;
      expect(b1.version).toBe('v1.120.0');
      expect(b2.version).toBe('v1.120.0');
    });
  });

  describe('GET /changelog', () => {
    it('returns 400 when version is missing', async () => {
      const response = await exports.default.fetch('https://example.com/changelog');
      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: string };
      expect(body.error).toContain('version');
    });

    it('returns 400 for invalid version format', async () => {
      const response = await exports.default.fetch('https://example.com/changelog?version=invalid');
      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: string };
      expect(body.error).toContain('Invalid version');
    });

    it('returns releases newer than the provided version', async () => {
      const response = await exports.default.fetch('https://example.com/changelog?version=v1.100.0');
      expect(response.status).toBe(200);
      const body = (await response.json()) as any;
      expect(body.current).toBe('v1.100.0');
      expect(body.latest.tag_name).toBe('v1.120.0');
      expect(body.releases).toHaveLength(2);
      expect(body.releases[0].tag_name).toBe('v1.120.0');
      expect(body.releases[1].tag_name).toBe('v1.110.0');
    });

    it('returns empty releases when on latest version', async () => {
      const response = await exports.default.fetch('https://example.com/changelog?version=v1.120.0');
      expect(response.status).toBe(200);
      const body = (await response.json()) as any;
      expect(body.releases).toHaveLength(0);
    });

    it('handles version without v prefix', async () => {
      const response = await exports.default.fetch('https://example.com/changelog?version=1.100.0');
      expect(response.status).toBe(200);
      const body = (await response.json()) as any;
      expect(body.current).toBe('1.100.0');
      expect(body.releases).toHaveLength(2);
    });

    it('returns all releases when version is very old', async () => {
      const response = await exports.default.fetch('https://example.com/changelog?version=v1.0.0');
      expect(response.status).toBe(200);
      const body = (await response.json()) as any;
      expect(body.releases).toHaveLength(3);
    });

    it('includes Cache-Control header for CDN caching', async () => {
      const response = await exports.default.fetch('https://example.com/changelog?version=v1.100.0');
      expect(response.headers.get('Cache-Control')).toBe('public, max-age=86400');
    });

    it('returns empty results when D1 has no data', async () => {
      await env.VERSION_DB.exec('DELETE FROM releases');
      const response = await exports.default.fetch('https://example.com/changelog?version=v1.0.0');
      expect(response.status).toBe(200);
      const body = (await response.json()) as any;
      expect(body.releases).toHaveLength(0);
      expect(body.latest).toBeNull();
    });
  });

  describe('GET /changelog - release channels', () => {
    it('does not error when the requested version is a pre-release', async () => {
      // Regression: getNewerThan used to bind the whole prerelease array, throwing D1_TYPE_ERROR -> 500.
      const response = await exports.default.fetch('https://example.com/changelog?version=v1.121.0-rc.1');
      expect(response.status).toBe(200);
      const body = (await response.json()) as any;
      expect(body.current).toBe('v1.121.0-rc.1');
    });

    it('returns 400 for an invalid channel', async () => {
      const response = await exports.default.fetch('https://example.com/changelog?version=v1.100.0&channel=nightly');
      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: string };
      expect(body.error).toContain('channel');
    });

    it('defaults to the stable channel when none is provided', async () => {
      await insertRelease({ id: 20, tag_name: 'v1.121.0-rc.1' });

      const response = await exports.default.fetch('https://example.com/changelog?version=v1.120.0');
      const body = (await response.json()) as any;
      const tags = body.releases.map((r: any) => r.tag_name);
      expect(tags).not.toContain('v1.121.0-rc.1');
      expect(body.latest.tag_name).toBe('v1.120.0');
    });

    it('includes pre-releases on the rc channel but excludes them on stable', async () => {
      await insertRelease({ id: 20, tag_name: 'v1.121.0-rc.1' });

      const rc = await exports.default.fetch('https://example.com/changelog?version=v1.120.0&channel=rc');
      const rcBody = (await rc.json()) as any;
      const rcTags = rcBody.releases.map((r: any) => r.tag_name);
      expect(rcTags).toContain('v1.121.0-rc.1');
      expect(rcBody.latest.tag_name).toBe('v1.121.0-rc.1');

      const stable = await exports.default.fetch('https://example.com/changelog?version=v1.120.0&channel=stable');
      const stableBody = (await stable.json()) as any;
      expect(stableBody.releases).toHaveLength(0);
      expect(stableBody.latest.tag_name).toBe('v1.120.0');
    });

    it('treats a stable release as newer than its own pre-release on the rc channel', async () => {
      await insertRelease({ id: 21, tag_name: 'v1.121.0-rc.1' });
      await insertRelease({ id: 22, tag_name: 'v1.121.0' });

      const response = await exports.default.fetch('https://example.com/changelog?version=v1.120.0&channel=rc');
      const body = (await response.json()) as any;
      // Stable 1.121.0 outranks 1.121.0-rc.1 in semver, so it must be both latest and first.
      expect(body.latest.tag_name).toBe('v1.121.0');
      expect(body.releases[0].tag_name).toBe('v1.121.0');
    });

    it('reports the stable as rc-channel latest once it supersedes the pre-release', async () => {
      // Once 3.0.0 ships, an rc-channel client must see 3.0.0 rather than 3.0.0-rc.2.
      await insertRelease({ id: 30, tag_name: 'v3.0.0-rc.2', published_at: '2025-01-01T00:00:00Z' });
      await insertRelease({ id: 31, tag_name: 'v3.0.0', published_at: '2025-02-01T00:00:00Z' });

      const response = await exports.default.fetch('https://example.com/changelog?version=v1.0.0&channel=rc');
      const body = (await response.json()) as any;
      expect(body.latest.tag_name).toBe('v3.0.0');
    });

    it('orders rc-channel latest by semver precedence, not publish date', async () => {
      // 2.8.1 is a patch to an older line, published *after* 3.0.0-rc.2. The rc channel must still
      // report 3.0.0-rc.2 as latest because it is the highest semver, not the most recently published.
      await insertRelease({ id: 32, tag_name: 'v3.0.0-rc.2', published_at: '2025-01-01T00:00:00Z' });
      await insertRelease({ id: 33, tag_name: 'v2.8.1', published_at: '2025-06-01T00:00:00Z' });

      const response = await exports.default.fetch('https://example.com/changelog?version=v1.0.0&channel=rc');
      const body = (await response.json()) as any;
      expect(body.latest.tag_name).toBe('v3.0.0-rc.2');
      expect(body.releases[0].tag_name).toBe('v3.0.0-rc.2');
    });

    it('returns newer pre-releases and the matching stable for a user on a pre-release', async () => {
      await insertRelease({ id: 23, tag_name: 'v1.121.0-rc.1' });
      await insertRelease({ id: 24, tag_name: 'v1.121.0-rc.2' });
      await insertRelease({ id: 25, tag_name: 'v1.121.0' });

      const response = await exports.default.fetch('https://example.com/changelog?version=v1.121.0-rc.1&channel=rc');
      const body = (await response.json()) as any;
      const tags = body.releases.map((r: any) => r.tag_name);
      expect(tags).toContain('v1.121.0-rc.2');
      expect(tags).toContain('v1.121.0');
      expect(tags).not.toContain('v1.121.0-rc.1'); // a version is not newer than itself
    });
  });

  describe('POST /webhook', () => {
    const webhookSecret = 'test-secret';

    it('returns 401 without signature', async () => {
      const response = await exports.default.fetch('https://example.com/webhook', {
        method: 'POST',
        body: '{}',
      });
      expect(response.status).toBe(401);
    });

    it('returns 401 with invalid signature', async () => {
      const response = await exports.default.fetch('https://example.com/webhook', {
        method: 'POST',
        body: '{}',
        headers: { 'X-Hub-Signature-256': 'sha256=invalid' },
      });
      expect(response.status).toBe(401);
    });

    it('returns 405 for non-POST requests', async () => {
      const response = await exports.default.fetch('https://example.com/webhook');
      expect(response.status).toBe(405);
    });

    it('ignores non-release events', async () => {
      const body = JSON.stringify({ action: 'opened' });
      const signature = await createWebhookSignature(body, webhookSecret);
      const response = await exports.default.fetch('https://example.com/webhook', {
        method: 'POST',
        body,
        headers: {
          'X-Hub-Signature-256': signature,
          'X-GitHub-Event': 'pull_request',
        },
      });
      expect(response.status).toBe(200);
      const result = (await response.json()) as any;
      expect(result.ignored).toBe(true);
    });

    it('ignores non-published release actions', async () => {
      const body = JSON.stringify({ action: 'created', release: {} });
      const signature = await createWebhookSignature(body, webhookSecret);
      const response = await exports.default.fetch('https://example.com/webhook', {
        method: 'POST',
        body,
        headers: {
          'X-Hub-Signature-256': signature,
          'X-GitHub-Event': 'release',
        },
      });
      expect(response.status).toBe(200);
      const result = (await response.json()) as any;
      expect(result.ignored).toBe(true);
    });

    it('upserts a published release and invalidates cache', async () => {
      // Prime the cache
      await exports.default.fetch('https://example.com/version');

      const releasePayload = {
        action: 'published',
        release: {
          id: 4,
          tag_name: 'v1.130.0',
          name: 'v1.130.0',
          url: 'https://api.github.com/repos/immich-app/immich/releases/4',
          body: 'New release',
          created_at: '2025-04-01T00:00:00Z',
          published_at: '2025-04-01T00:00:00Z',
        },
      };

      const body = JSON.stringify(releasePayload);
      const signature = await createWebhookSignature(body, webhookSecret);
      const response = await exports.default.fetch('https://example.com/webhook', {
        method: 'POST',
        body,
        headers: {
          'X-Hub-Signature-256': signature,
          'X-GitHub-Event': 'release',
        },
      });
      expect(response.status).toBe(200);
      const result = (await response.json()) as any;
      expect(result.success).toBe(true);

      // Verify the new release is now the latest (cache was invalidated)
      const versionResponse = await exports.default.fetch('https://example.com/version');
      const versionBody = (await versionResponse.json()) as any;
      expect(versionBody.version).toBe('v1.130.0');
    });

    it('updates an existing release body', async () => {
      const releasePayload = {
        action: 'published',
        release: {
          id: 3,
          tag_name: 'v1.120.0',
          name: 'v1.120.0',
          url: 'https://api.github.com/repos/immich-app/immich/releases/3',
          body: 'Updated release notes',
          created_at: '2025-03-01T00:00:00Z',
          published_at: '2025-03-01T00:00:00Z',
        },
      };

      const body = JSON.stringify(releasePayload);
      const signature = await createWebhookSignature(body, webhookSecret);
      await exports.default.fetch('https://example.com/webhook', {
        method: 'POST',
        body,
        headers: {
          'X-Hub-Signature-256': signature,
          'X-GitHub-Event': 'release',
        },
      });

      const response = await exports.default.fetch('https://example.com/changelog?version=v1.110.0');
      const changelog = (await response.json()) as any;
      expect(changelog.releases[0].body).toBe('Updated release notes');
    });

    it('returns 400 for invalid release payload', async () => {
      const releasePayload = {
        action: 'published',
        release: { no_id: true },
      };

      const body = JSON.stringify(releasePayload);
      const signature = await createWebhookSignature(body, webhookSecret);
      const response = await exports.default.fetch('https://example.com/webhook', {
        method: 'POST',
        body,
        headers: {
          'X-Hub-Signature-256': signature,
          'X-GitHub-Event': 'release',
        },
      });
      expect(response.status).toBe(400);
    });

    it('ignores draft releases', async () => {
      const releasePayload = {
        action: 'published',
        release: {
          id: 5,
          tag_name: 'v1.140.0',
          name: 'v1.140.0',
          url: '',
          body: '',
          created_at: '',
          published_at: '',
          draft: true,
        },
      };

      const body = JSON.stringify(releasePayload);
      const signature = await createWebhookSignature(body, webhookSecret);
      const response = await exports.default.fetch('https://example.com/webhook', {
        method: 'POST',
        body,
        headers: {
          'X-Hub-Signature-256': signature,
          'X-GitHub-Event': 'release',
        },
      });
      expect(response.status).toBe(200);
      const result = (await response.json()) as any;
      expect(result.ignored).toBe(true);
    });

    it('ignores prerelease releases', async () => {
      const releasePayload = {
        action: 'published',
        release: {
          id: 6,
          tag_name: 'v1.121.0-rc.1',
          name: 'v1.121.0-rc.1',
          url: '',
          body: '',
          created_at: '',
          published_at: '',
          prerelease: true,
        },
      };

      const body = JSON.stringify(releasePayload);
      const signature = await createWebhookSignature(body, webhookSecret);
      const response = await exports.default.fetch('https://example.com/webhook', {
        method: 'POST',
        body,
        headers: {
          'X-Hub-Signature-256': signature,
          'X-GitHub-Event': 'release',
        },
      });
      expect(response.status).toBe(200);
      const result = (await response.json()) as any;
      expect(result.ignored).toBe(true);
    });
  });

  describe('Unknown routes', () => {
    it('returns 404 for unknown paths', async () => {
      const response = await exports.default.fetch('https://example.com/unknown');
      expect(response.status).toBe(404);
    });
  });
});

describe('Cron sync', () => {
  beforeAll(async () => {
    await createSchema();
  });

  beforeEach(async () => {
    versionCache.invalidate();
    revalidationState.inFlight = false;
    await env.VERSION_DB.exec('DELETE FROM releases');
    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);

      if (
        request.method === 'GET' &&
        url.origin === 'https://api.github.com' &&
        url.pathname === '/repos/immich-app/immich/releases' &&
        url.searchParams.get('per_page') === '100' &&
        url.searchParams.get('page') === '1'
      ) {
        return Promise.resolve(Response.json(mockReleases));
      }

      return fetch(input, init);
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('fetches from GitHub and populates D1', async () => {
    const response = await exports.default.fetch('https://example.com/changelog?version=v1.100.0');
    expect(response.status).toBe(200);
    const body = (await response.json()) as any;
    // D1 is empty, so no releases
    expect(body.releases).toHaveLength(0);

    // Seed directly to simulate cron populating D1
    await seedReleases();

    const response2 = await exports.default.fetch('https://example.com/changelog?version=v1.100.0');
    const body2 = (await response2.json()) as any;
    expect(body2.releases).toHaveLength(2);
    expect(body2.latest.tag_name).toBe('v1.120.0');
  });

  it('returns latest version from GitHub when cache is empty', async () => {
    // Seed D1 directly
    await seedReleases();

    const response = await exports.default.fetch('https://example.com/version');
    expect(response.status).toBe(200);
    const body = (await response.json()) as any;
    expect(body.version).toBe('v1.120.0');
    expect(body.published_at).toBe('2025-03-01T00:00:00Z');
  });
});

describe('CDN cache immutable headers fix', () => {
  it('cached responses must be wrapped to allow header mutation', async () => {
    const cache = caches.default;
    const key = new Request('https://example.com/test-immutable-headers');

    const original = Response.json(
      { data: 'test' },
      {
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=300' },
      },
    );
    await cache.put(key, original.clone());

    const cached = await cache.match(key);
    expect(cached).not.toBeNull();

    // Cached responses have immutable headers - setting directly would throw
    expect(() => cached!.headers.set('Server-Timing', 'test;dur=1')).toThrow();

    // The fix: wrapping in new Response() creates mutable headers
    const mutable = new Response(cached!.body, cached!);
    expect(() => mutable.headers.set('Server-Timing', 'test;dur=1')).not.toThrow();
    expect(mutable.headers.get('Server-Timing')).toBe('test;dur=1');

    // Verify body is preserved
    const body = (await mutable.json()) as any;
    expect(body.data).toBe('test');

    await cache.delete(key);
  });
});
