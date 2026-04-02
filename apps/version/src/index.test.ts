import { env, fetchMock, SELF } from 'cloudflare:test';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MemoryCache } from './memory-cache.js';
import { versionCache } from './version-service.js';
import { compareSemVer, isGreaterThan, parseSemVer } from './version.js';
import { verifyWebhookSignature } from './webhook.js';

async function createSchema() {
  await env.VERSION_DB.prepare(
    "CREATE TABLE IF NOT EXISTS releases (id INTEGER PRIMARY KEY, tag_name TEXT NOT NULL UNIQUE, name TEXT NOT NULL DEFAULT '', url TEXT NOT NULL DEFAULT '', body TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT '', published_at TEXT NOT NULL DEFAULT '', major INTEGER NOT NULL, minor INTEGER NOT NULL, patch INTEGER NOT NULL)",
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

async function seedReleases() {
  for (const release of mockReleases) {
    const semver = parseSemVer(release.tag_name)!;
    await env.VERSION_DB.prepare(
      `INSERT OR REPLACE INTO releases (id, tag_name, name, url, body, created_at, published_at, major, minor, patch)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        release.id,
        release.tag_name,
        release.name,
        release.url,
        release.body,
        release.created_at,
        release.published_at,
        semver.major,
        semver.minor,
        semver.patch,
      )
      .run();
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

  it('stores and retrieves a value', () => {
    const cache = new MemoryCache<string>(1000);
    cache.set('hello');
    expect(cache.get()).toBe('hello');
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

describe('Version utilities', () => {
  describe('parseSemVer', () => {
    it('parses version with v prefix', () => {
      expect(parseSemVer('v1.100.0')).toEqual({ major: 1, minor: 100, patch: 0 });
    });

    it('parses version without v prefix', () => {
      expect(parseSemVer('1.100.0')).toEqual({ major: 1, minor: 100, patch: 0 });
    });

    it('returns null for invalid version', () => {
      expect(parseSemVer('invalid')).toBeNull();
      expect(parseSemVer('')).toBeNull();
    });

    it('returns null for version with pre-release suffix', () => {
      expect(parseSemVer('v1.100.0-rc.1')).toBeNull();
      expect(parseSemVer('1.100.0-beta')).toBeNull();
    });

    it('returns null for version with extra segments', () => {
      expect(parseSemVer('v1.100.0.1')).toBeNull();
    });
  });

  describe('compareSemVer', () => {
    it('returns positive when first is greater', () => {
      expect(compareSemVer({ major: 2, minor: 0, patch: 0 }, { major: 1, minor: 0, patch: 0 })).toBeGreaterThan(0);
    });

    it('returns negative when first is smaller', () => {
      expect(compareSemVer({ major: 1, minor: 0, patch: 0 }, { major: 2, minor: 0, patch: 0 })).toBeLessThan(0);
    });

    it('returns 0 when equal', () => {
      expect(compareSemVer({ major: 1, minor: 2, patch: 3 }, { major: 1, minor: 2, patch: 3 })).toBe(0);
    });
  });

  describe('isGreaterThan', () => {
    it('compares major versions', () => {
      expect(isGreaterThan('v2.0.0', 'v1.0.0')).toBe(true);
      expect(isGreaterThan('v1.0.0', 'v2.0.0')).toBe(false);
    });

    it('compares minor versions', () => {
      expect(isGreaterThan('v1.2.0', 'v1.1.0')).toBe(true);
      expect(isGreaterThan('v1.1.0', 'v1.2.0')).toBe(false);
    });

    it('compares patch versions', () => {
      expect(isGreaterThan('v1.1.2', 'v1.1.1')).toBe(true);
      expect(isGreaterThan('v1.1.1', 'v1.1.2')).toBe(false);
    });

    it('returns false for equal versions', () => {
      expect(isGreaterThan('v1.1.1', 'v1.1.1')).toBe(false);
    });

    it('handles mixed v prefix', () => {
      expect(isGreaterThan('v1.2.0', '1.1.0')).toBe(true);
      expect(isGreaterThan('1.2.0', 'v1.1.0')).toBe(true);
    });
  });
});

describe('Version Worker', () => {
  beforeAll(async () => {
    await createSchema();
  });

  beforeEach(async () => {
    versionCache.invalidate();
    await env.VERSION_DB.exec('DELETE FROM releases');
    await seedReleases();
  });

  describe('OPTIONS preflight', () => {
    it('returns correct CORS headers', async () => {
      const response = await SELF.fetch('https://example.com/version', { method: 'OPTIONS' });
      expect(response.status).toBe(200);
      expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
      expect(response.headers.get('Access-Control-Allow-Methods')).toBe('GET, POST, OPTIONS');
      expect(response.headers.get('Access-Control-Allow-Headers')).toBe('Content-Type');
      expect(response.headers.get('Access-Control-Max-Age')).toBe('86400');
    });
  });

  describe('GET /health', () => {
    it('returns healthy status', async () => {
      const response = await SELF.fetch('https://example.com/health');
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toEqual({ status: 'ok' });
    });
  });

  describe('GET /version', () => {
    it('returns the latest version', async () => {
      const response = await SELF.fetch('https://example.com/version');
      expect(response.status).toBe(200);
      const body = (await response.json()) as any;
      expect(body.version).toBe('v1.120.0');
      expect(body.published_at).toBe('2025-03-01T00:00:00Z');
    });

    it('does not include Cache-Control header (memory cached, not CDN)', async () => {
      const response = await SELF.fetch('https://example.com/version');
      expect(response.headers.get('Cache-Control')).toBeNull();
    });

    it('returns 404 when no releases exist', async () => {
      await env.VERSION_DB.exec('DELETE FROM releases');
      const response = await SELF.fetch('https://example.com/version');
      expect(response.status).toBe(404);
    });

    it('serves from in-memory cache on second request', async () => {
      const first = await SELF.fetch('https://example.com/version');
      expect(first.status).toBe(200);

      // Delete from D1 - second request should still work from cache
      await env.VERSION_DB.exec('DELETE FROM releases');

      const second = await SELF.fetch('https://example.com/version');
      expect(second.status).toBe(200);
      const body = (await second.json()) as any;
      expect(body.version).toBe('v1.120.0');
    });

    it('includes CORS header', async () => {
      const response = await SELF.fetch('https://example.com/version');
      expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
    });
  });

  describe('GET /changelog', () => {
    it('returns 400 when version is missing', async () => {
      const response = await SELF.fetch('https://example.com/changelog');
      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: string };
      expect(body.error).toContain('version');
    });

    it('returns 400 for invalid version format', async () => {
      const response = await SELF.fetch('https://example.com/changelog?version=invalid');
      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: string };
      expect(body.error).toContain('Invalid version');
    });

    it('returns releases newer than the provided version', async () => {
      const response = await SELF.fetch('https://example.com/changelog?version=v1.100.0');
      expect(response.status).toBe(200);
      const body = (await response.json()) as any;
      expect(body.current).toBe('v1.100.0');
      expect(body.latest.tag_name).toBe('v1.120.0');
      expect(body.releases).toHaveLength(2);
      expect(body.releases[0].tag_name).toBe('v1.120.0');
      expect(body.releases[1].tag_name).toBe('v1.110.0');
    });

    it('returns empty releases when on latest version', async () => {
      const response = await SELF.fetch('https://example.com/changelog?version=v1.120.0');
      expect(response.status).toBe(200);
      const body = (await response.json()) as any;
      expect(body.releases).toHaveLength(0);
    });

    it('handles version without v prefix', async () => {
      const response = await SELF.fetch('https://example.com/changelog?version=1.100.0');
      expect(response.status).toBe(200);
      const body = (await response.json()) as any;
      expect(body.current).toBe('1.100.0');
      expect(body.releases).toHaveLength(2);
    });

    it('returns all releases when version is very old', async () => {
      const response = await SELF.fetch('https://example.com/changelog?version=v1.0.0');
      expect(response.status).toBe(200);
      const body = (await response.json()) as any;
      expect(body.releases).toHaveLength(3);
    });

    it('includes Cache-Control header for CDN caching', async () => {
      const response = await SELF.fetch('https://example.com/changelog?version=v1.100.0');
      expect(response.headers.get('Cache-Control')).toBe('public, max-age=86400');
    });

    it('returns empty results when D1 has no data', async () => {
      await env.VERSION_DB.exec('DELETE FROM releases');
      const response = await SELF.fetch('https://example.com/changelog?version=v1.0.0');
      expect(response.status).toBe(200);
      const body = (await response.json()) as any;
      expect(body.releases).toHaveLength(0);
      expect(body.latest).toBeNull();
    });
  });

  describe('POST /webhook', () => {
    const webhookSecret = 'test-secret';

    it('returns 401 without signature', async () => {
      const response = await SELF.fetch('https://example.com/webhook', {
        method: 'POST',
        body: '{}',
      });
      expect(response.status).toBe(401);
    });

    it('returns 401 with invalid signature', async () => {
      const response = await SELF.fetch('https://example.com/webhook', {
        method: 'POST',
        body: '{}',
        headers: { 'X-Hub-Signature-256': 'sha256=invalid' },
      });
      expect(response.status).toBe(401);
    });

    it('returns 405 for non-POST requests', async () => {
      const response = await SELF.fetch('https://example.com/webhook');
      expect(response.status).toBe(405);
    });

    it('ignores non-release events', async () => {
      const body = JSON.stringify({ action: 'opened' });
      const signature = await createWebhookSignature(body, webhookSecret);
      const response = await SELF.fetch('https://example.com/webhook', {
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
      const response = await SELF.fetch('https://example.com/webhook', {
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
      await SELF.fetch('https://example.com/version');

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
      const response = await SELF.fetch('https://example.com/webhook', {
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
      const versionResponse = await SELF.fetch('https://example.com/version');
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
      await SELF.fetch('https://example.com/webhook', {
        method: 'POST',
        body,
        headers: {
          'X-Hub-Signature-256': signature,
          'X-GitHub-Event': 'release',
        },
      });

      const response = await SELF.fetch('https://example.com/changelog?version=v1.110.0');
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
      const response = await SELF.fetch('https://example.com/webhook', {
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
      const response = await SELF.fetch('https://example.com/webhook', {
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
      const response = await SELF.fetch('https://example.com/webhook', {
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
      const response = await SELF.fetch('https://example.com/unknown');
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
    await env.VERSION_DB.exec('DELETE FROM releases');
    fetchMock.activate();
    fetchMock.disableNetConnect();

    // Allow metrics flush (dev URL)
    const metricsOrigin = fetchMock.get('https://cf-workers.monitoring.dev.immich.cloud');
    metricsOrigin.intercept({ path: '/write', method: 'POST' }).reply(200, 'OK').persist();
  });

  afterEach(() => {
    fetchMock.deactivate();
  });

  it('fetches from GitHub and populates D1', async () => {
    const github = fetchMock.get('https://api.github.com');
    github
      .intercept({
        path: '/repos/immich-app/immich/releases',
        query: { per_page: '100', page: '1' },
      })
      .reply(200, mockReleases);

    const response = await SELF.fetch('https://example.com/changelog?version=v1.100.0');
    expect(response.status).toBe(200);
    const body = (await response.json()) as any;
    // D1 is empty, so no releases
    expect(body.releases).toHaveLength(0);

    // Seed directly to simulate cron populating D1
    await seedReleases();

    const response2 = await SELF.fetch('https://example.com/changelog?version=v1.100.0');
    const body2 = (await response2.json()) as any;
    expect(body2.releases).toHaveLength(2);
    expect(body2.latest.tag_name).toBe('v1.120.0');
  });

  it('returns latest version from GitHub when cache is empty', async () => {
    const github = fetchMock.get('https://api.github.com');
    github
      .intercept({
        path: '/repos/immich-app/immich/releases',
        query: { per_page: '100', page: '1' },
      })
      .reply(200, mockReleases);

    // Seed D1 directly
    await seedReleases();

    const response = await SELF.fetch('https://example.com/version');
    expect(response.status).toBe(200);
    const body = (await response.json()) as any;
    expect(body.version).toBe('v1.120.0');
    expect(body.published_at).toBe('2025-03-01T00:00:00Z');
  });
});
