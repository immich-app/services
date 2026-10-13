import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

// eslint-disable-next-line unicorn/no-top-level-side-effects
export default defineConfig({
  test: {
    include: ['src/integration.test.ts'],
  },
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.toml' },
      miniflare: {
        bindings: {
          CLOUDFLARE_API_TOKEN: process.env.CLOUDFLARE_API_TOKEN ?? '',
          CLOUDFLARE_ACCOUNT_ID: process.env.CLOUDFLARE_ACCOUNT_ID ?? '',
        },
      },
    }),
  ],
});
