import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

describe('HTTP handler', () => {
  it('returns 200 for /health', async () => {
    const response = await SELF.fetch('https://example.com/health');
    expect(response.status).toBe(200);
    const body = (await response.json()) as { status: string };
    expect(body.status).toBe('ok');
  });

  it('returns 404 for unknown routes', async () => {
    const response = await SELF.fetch('https://example.com/nope');
    expect(response.status).toBe(404);
  });

  it('returns 404 for /collect — the manual trigger endpoint has been removed', async () => {
    const response = await SELF.fetch('https://example.com/collect');
    expect(response.status).toBe(404);
  });
});
