const DEFAULT_BASE_URL = 'https://api.cloudflare.com/client/v4';
const DEFAULT_PAGE_SIZE = 100;

export interface D1Database {
  uuid: string;
  name: string;
}

export interface Queue {
  queue_id: string;
  queue_name: string;
}

export interface Zone {
  id: string;
  name: string;
}

interface CloudflareListResponse<T> {
  result: T[] | null;
  result_info?: {
    page: number;
    per_page: number;
    total_pages: number;
    count: number;
    total_count: number;
  };
  success: boolean;
  errors?: Array<{ code: number; message: string }>;
}

export class CloudflareRestError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
  ) {
    super(message);
    this.name = 'CloudflareRestError';
  }
}

export interface ICloudflareRestClient {
  listD1Databases(accountId: string): Promise<D1Database[]>;
  listQueues(accountId: string): Promise<Queue[]>;
  listZones(accountId: string): Promise<Zone[]>;
  /**
   * Fetches a single zone by id. Returns `null` when the zone is not found
   * (so callers can treat missing zones as a best-effort miss rather than an
   * error). Other HTTP errors are thrown as `CloudflareRestError`.
   */
  getZone(zoneId: string): Promise<Zone | null>;
}

/**
 * Thin client for the Cloudflare v4 REST API, used to resolve resource
 * metadata (names, tags) that isn't exposed via the GraphQL Analytics API.
 *
 * Only the endpoints we need for tag enrichment are implemented; everything
 * else should go through the GraphQL client in `graphql-client.ts`.
 */
export class CloudflareRestClient implements ICloudflareRestClient {
  constructor(
    private readonly apiToken: string,
    private readonly baseUrl: string = DEFAULT_BASE_URL,
    private readonly fetchImpl?: typeof fetch,
  ) {}

  async listD1Databases(accountId: string): Promise<D1Database[]> {
    return this.listPaginated<D1Database>(`/accounts/${encodeURIComponent(accountId)}/d1/database`);
  }

  async listQueues(accountId: string): Promise<Queue[]> {
    return this.listPaginated<Queue>(`/accounts/${encodeURIComponent(accountId)}/queues`);
  }

  async listZones(accountId: string): Promise<Zone[]> {
    return this.listPaginated<Zone>(`/zones?account.id=${encodeURIComponent(accountId)}`);
  }

  async getZone(zoneId: string): Promise<Zone | null> {
    const doFetch = this.fetchImpl ?? globalThis.fetch;
    const url = `${this.baseUrl}/zones/${encodeURIComponent(zoneId)}`;
    const response = await doFetch(url, {
      headers: { Authorization: `Bearer ${this.apiToken}` },
    });
    if (response.status === 404) {
      await response.body?.cancel();
      return null;
    }
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new CloudflareRestError(
        `Cloudflare REST error (${response.status}) for /zones/${zoneId}: ${body.slice(0, 200)}`,
        response.status,
      );
    }
    const payload = (await response.json()) as { result: Zone | null };
    return payload.result ?? null;
  }

  private async listPaginated<T>(path: string): Promise<T[]> {
    const all: T[] = [];
    let page = 1;
    const separator = path.includes('?') ? '&' : '?';
    const doFetch = this.fetchImpl ?? globalThis.fetch;
    for (;;) {
      const url = `${this.baseUrl}${path}${separator}page=${page}&per_page=${DEFAULT_PAGE_SIZE}`;
      const response = await doFetch(url, {
        headers: { Authorization: `Bearer ${this.apiToken}` },
      });
      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new CloudflareRestError(
          `Cloudflare REST error (${response.status}) for ${path}: ${body.slice(0, 200)}`,
          response.status,
        );
      }
      const payload = (await response.json()) as CloudflareListResponse<T>;
      if (payload.result) {
        all.push(...payload.result);
      }
      const info = payload.result_info;
      if (!info || page >= (info.total_pages ?? 1)) {
        break;
      }
      page++;
    }
    return all;
  }
}
