import { WeblateLockResponse } from './interface.js';
import { CloudflareDeferredRepository, InfluxMetricsProvider, Metric } from './repository';

async function fetchLockMetric(baseEndpoint: URL): Metric {
  const lockEndpoint = new URL('lock/', baseEndpoint);

  const lockResponse = await fetch(lockEndpoint);
  const json = (await lockResponse.json()) as WeblateLockResponse;
  const metric = Metric.create('immich_weblate').intField('locked', json.locked ? 1 : 0);
  return metric;
}

export default {
  // eslint-disable-next-line @typescript-eslint/require-await
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    const deferred = new CloudflareDeferredRepository(ctx);
    const metrics = new InfluxMetricsProvider(env.VMETRICS_API_TOKEN, env.ENVIRONMENT);
    deferred.defer(() => metrics.flush());

    const baseEndpoint = new URL(`api/components/${env.WEBLATE_COMPONENT}/`, env.WEBLATE_HOST);

    metrics.pushMetric(fetchLockMetric(baseEndpoint));
  },
};
