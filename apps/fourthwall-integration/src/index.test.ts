import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

describe('Fourthwall Integration Worker', () => {
  it('should return hello message on root path', async () => {
    const response = await SELF.fetch('https://example.com/');
    const data = (await response.json()) as any;

    expect(response.status).toBe(200);
    expect(data).toHaveProperty('message', 'Fourthwall Integration API');
    expect(data).toHaveProperty('timestamp');
  });

  it('should return health status', async () => {
    const response = await SELF.fetch('https://example.com/health');
    const data = (await response.json()) as any;

    expect(response.status).toBe(200);
    expect(data).toHaveProperty('status', 'healthy');
  });

  it('should return method not allowed for webhooks without POST', async () => {
    const response = await SELF.fetch('https://example.com/webhook/fourthwall');
    
    expect(response.status).toBe(405);
    expect(await response.text()).toBe('Method not allowed');
  });

  it('should return 404 for unknown routes', async () => {
    const response = await SELF.fetch('https://example.com/unknown');
    const data = (await response.json()) as any;

    expect(response.status).toBe(404);
    expect(data).toHaveProperty('error', 'Not Found');
  });
});
