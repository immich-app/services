import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { CloudflareMetricsCollector } from './collector.js';
import { ALL_DATASETS } from './datasets.js';
import { CloudflareGraphQLClient } from './graphql-client.js';
import { CloudflareMetricsRepository, type IMetricsProviderRepository, Metric } from './metrics.js';
import type { DatasetRow } from './types.js';

/**
 * Integration tests: these hit the real Cloudflare GraphQL Analytics API.
 *
 * They are gated on `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` being
 * set (see `vitest.integration.config.ts` — the pool passes the variables
 * through as miniflare bindings). Run with:
 *
 *     CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... \
 *       pnpm --filter @immich-services/cloudflare-metrics run test:integration
 */

const hasCredentials = Boolean(env.CLOUDFLARE_API_TOKEN && env.CLOUDFLARE_ACCOUNT_ID);

class RecordingProvider implements IMetricsProviderRepository {
  readonly metrics: Metric[] = [];
  pushMetric(metric: Metric) {
    this.metrics.push(metric);
  }
  flush() {
    /* noop */
  }
}

function buildClient() {
  return new CloudflareGraphQLClient(env.CLOUDFLARE_API_TOKEN ?? '');
}

function buildMetricsRepo(provider: IMetricsProviderRepository) {
  return new CloudflareMetricsRepository(
    'cloudflare_metrics',
    new Request('https://localhost/integration'),
    [provider],
    '',
  );
}

function wideRange() {
  // Use a 1h lookback window ending 10m ago so we land in a fully
  // populated bucket without pulling an unreasonable amount of data.
  const end = new Date(Date.now() - 10 * 60 * 1000);
  const start = new Date(end.getTime() - 60 * 60 * 1000);
  return { start, end };
}

const INTEGRATION_TIMEOUT_MS = 60_000;

describe.skipIf(!hasCredentials)('Cloudflare GraphQL integration', () => {
  const client = buildClient();

  // Account-scoped datasets are fetched in a single batched request per
  // filter granularity, then iterated individually so we can assert on the
  // shape per dataset. Zone-scoped datasets are tested separately below.
  const accountDatasets = ALL_DATASETS.filter((d) => (d.scope ?? 'account') === 'account');

  it(
    'fetches every account-scope dataset in a single batched request',
    async () => {
      const datetimeDatasets = accountDatasets.filter((d) => (d.filterGranularity ?? 'datetime') === 'datetime');
      const dateDatasets = accountDatasets.filter((d) => d.filterGranularity === 'date');
      const range = wideRange();

      const datetimeResult = await client.fetchAccountBatch(env.CLOUDFLARE_ACCOUNT_ID ?? '', datetimeDatasets, range, {
        includeScheduledInvocations: true,
      });
      const dateResult = await client.fetchAccountBatch(env.CLOUDFLARE_ACCOUNT_ID ?? '', dateDatasets, range);

      for (const dataset of accountDatasets) {
        const rows = (datetimeResult.rows[dataset.key] ?? dateResult.rows[dataset.key]) as DatasetRow[] | undefined;
        const err = datetimeResult.errors[dataset.key] ?? dateResult.errors[dataset.key];
        if (err) {
          // Plan-gated datasets (e.g. firewallEventsAdaptiveGroups) return an
          // authz error; we don't include those in the registry but if they
          // ever get added we want a clear failure here.
          throw new Error(`Dataset ${dataset.key} returned error: ${err}`);
        }
        expect(Array.isArray(rows), `rows for ${dataset.key} should be an array`).toBe(true);
        if (!rows) {
          continue;
        }
        for (const row of rows) {
          expect(row.dimensions).toBeDefined();
          const timestampDim = dataset.timestampDimension ?? 'datetimeMinute';
          expect(row.dimensions[timestampDim]).toBeDefined();
          for (const [, spec] of Object.entries(dataset.fields)) {
            const [block, key] = spec.source;
            if (block === '_top') {
              continue;
            }
            const blockData = (row as unknown as Record<string, Record<string, unknown> | undefined>)[block];
            if (blockData && key in blockData) {
              const value = blockData[key];
              expect(value === null || typeof value === 'number', `${dataset.key}.${block}.${key}`).toBe(true);
            }
          }
        }
      }
      expect(datetimeResult.scheduledInvocations).toBeDefined();
    },
    INTEGRATION_TIMEOUT_MS,
  );

  it(
    'runs the full collector against the live account and emits measurements',
    async () => {
      const provider = new RecordingProvider();
      const metrics = buildMetricsRepo(provider);
      const collector = new CloudflareMetricsCollector(client, env.CLOUDFLARE_ACCOUNT_ID ?? '', metrics, {
        // Narrower window — the goal is to verify the full pipeline works, not
        // to fetch a full day of data.
        lagMs: 5 * 60 * 1000,
        windowMs: 60 * 60 * 1000,
      });
      const results = await collector.collectAll(ALL_DATASETS);

      // At least one dataset should succeed against our account.
      const successes = results.filter((r) => !r.error);
      expect(successes.length).toBeGreaterThan(0);

      // Every emitted metric should have a timestamp and an account_id tag.
      const exported = provider.metrics.filter((m) => m.name.startsWith('cf_'));
      for (const metric of exported) {
        expect(metric.exportTimestamp).toBeDefined();
        expect(metric.tags.get('account_id')).toBe(env.CLOUDFLARE_ACCOUNT_ID);
      }

      console.log(
        `[integration] ${successes.length}/${results.length} datasets succeeded, emitted ${exported.length} metrics`,
      );
      for (const result of results) {
        if (result.error) {
          console.warn(`[integration] ${result.dataset} error: ${result.error}`);
        }
      }
    },
    INTEGRATION_TIMEOUT_MS,
  );
});

describe.skipIf(hasCredentials)('Cloudflare GraphQL integration (skipped)', () => {
  it('is skipped when CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID are unset', () => {
    expect(hasCredentials).toBe(false);
  });
});
