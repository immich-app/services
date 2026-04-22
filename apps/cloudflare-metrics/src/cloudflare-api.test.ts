import { describe, expect, it, vi } from 'vitest';
import { CloudflareRestClient, CloudflareRestError } from './cloudflare-api.js';

describe('CloudflareRestClient', () => {
  it('paginates through listD1Databases', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            success: true,
            result: [{ uuid: 'a', name: 'one' }],
            result_info: { page: 1, per_page: 100, total_pages: 2, count: 1, total_count: 2 },
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            success: true,
            result: [{ uuid: 'b', name: 'two' }],
            result_info: { page: 2, per_page: 100, total_pages: 2, count: 1, total_count: 2 },
          }),
          { status: 200 },
        ),
      );

    const client = new CloudflareRestClient('tok', 'https://example.com', fetchMock as unknown as typeof fetch);
    const dbs = await client.listD1Databases('acct');
    expect(dbs).toEqual([
      { uuid: 'a', name: 'one' },
      { uuid: 'b', name: 'two' },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const firstCall = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(firstCall[0]).toContain('/accounts/acct/d1/database?page=1');
    expect((firstCall[1].headers as Record<string, string>).Authorization).toBe('Bearer tok');
  });

  it('throws CloudflareRestError on non-OK responses', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('nope', { status: 403 }));
    const client = new CloudflareRestClient('tok', 'https://example.com', fetchMock as unknown as typeof fetch);
    await expect(client.listQueues('acct')).rejects.toBeInstanceOf(CloudflareRestError);
  });

  it('keeps the existing query string when listing zones', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          success: true,
          result: [{ id: 'z1', name: 'example.com' }],
          result_info: { page: 1, per_page: 100, total_pages: 1, count: 1, total_count: 1 },
        }),
        { status: 200 },
      ),
    );
    const client = new CloudflareRestClient('tok', 'https://example.com', fetchMock as unknown as typeof fetch);
    await client.listZones('acct');
    const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(call[0]).toContain('/zones?account.id=acct&page=1');
  });

  it('returns null from getZone when the API responds with 404', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('', { status: 404 }));
    const client = new CloudflareRestClient('tok', 'https://example.com', fetchMock as unknown as typeof fetch);
    const zone = await client.getZone('does-not-exist');
    expect(zone).toBeNull();
  });

  it('returns the zone payload from getZone on success', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          success: true,
          result: { id: 'z1', name: 'pages.example.com' },
        }),
        { status: 200 },
      ),
    );
    const client = new CloudflareRestClient('tok', 'https://example.com', fetchMock as unknown as typeof fetch);
    const zone = await client.getZone('z1');
    expect(zone).toEqual({ id: 'z1', name: 'pages.example.com' });
    const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(call[0]).toBe('https://example.com/zones/z1');
  });
});
