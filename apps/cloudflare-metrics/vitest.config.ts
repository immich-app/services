import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    exclude: ['**/node_modules/**', 'src/integration.test.ts'],
  },
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.toml' },
      miniflare: {
        // Inject a fake VictoriaMetrics token so the InfluxMetricsProvider
        // takes the real fetch path in tests — otherwise it short-circuits
        // in its "no token" branch and we can't observe flush behaviour.
        bindings: {
          VMETRICS_API_TOKEN: 'test-token',
        },
      },
    }),
  ],
});
