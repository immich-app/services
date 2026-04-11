import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

export default defineWorkersConfig({
  test: {
    exclude: ['**/node_modules/**', 'src/integration.test.ts'],
    poolOptions: {
      workers: {
        wrangler: { configPath: './wrangler.toml' },
        miniflare: {
          // Inject a fake VictoriaMetrics token so the InfluxMetricsProvider
          // takes the real fetch path in tests — otherwise it short-circuits
          // in its "no token" branch and we can't observe flush behaviour.
          bindings: {
            VMETRICS_API_TOKEN: 'test-token',
          },
        },
      },
    },
  },
});
