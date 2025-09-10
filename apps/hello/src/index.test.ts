import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

describe('Hello Worker', () => {
  it('should return hello message on root path', async () => {
    const response = await SELF.fetch('https://example.com/');
    const data = (await response.json()) as any;

    expect(response.status).toBe(200);
    expect(data).toHaveProperty('message', 'Hello from Immich Worker API!');
    expect(data).toHaveProperty('timestamp');
  });

  it('should return health status', async () => {
    const response = await SELF.fetch('https://example.com/health');
    const data = (await response.json()) as any;

    expect(response.status).toBe(200);
    expect(data).toHaveProperty('status', 'healthy');
  });

  it('should greet with name parameter', async () => {
    const response = await SELF.fetch('https://example.com/api/greet?name=Claude');
    const data = (await response.json()) as any;

    expect(response.status).toBe(200);
    expect(data).toHaveProperty('greeting', 'Hello, Claude!');
  });

  it('should return 404 for unknown routes', async () => {
    const response = await SELF.fetch('https://example.com/unknown');
    const data = (await response.json()) as any;

    expect(response.status).toBe(404);
    expect(data).toHaveProperty('error', 'Not Found');
  });
});
