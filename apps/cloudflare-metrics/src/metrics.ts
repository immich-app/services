import type { IMetricsProviderRepository } from './metric-providers.js';
import { Metric } from './metric.js';
import { type AsyncFn, type MonitorOptions, type Operation, monitorAsyncFunction } from './monitor.js';

// Re-exports preserve the legacy import paths while consumers migrate to
// the per-concern files. These will be trimmed back once every call site
// imports from the canonical location.
export {
  __resetFlushStateForTests as __resetMetricsModuleStateForTests,
  takeLastFlushStats,
  type LastFlushStats,
} from './flush-state.js';
export { HeaderMetricsProvider, InfluxMetricsProvider, type IMetricsProviderRepository } from './metric-providers.js';
export { Metric, type MetricFieldType } from './metric.js';

/**
 * Repository contract for metric sinks in the worker. A single instance is
 * constructed at the top of each request / cron tick and fans pushed
 * metrics out to one or more `IMetricsProviderRepository` implementations.
 */
export interface IMetricsRepository {
  monitorAsyncFunction<T extends AsyncFn>(
    operation: Operation,
    call: T,
    options?: MonitorOptions,
  ): (...args: Parameters<T>) => Promise<Awaited<ReturnType<T>>>;
  push(metric: Metric): void;
}

/**
 * Metrics facade used by handlers. Owns the per-request default tags
 * (environment, colo, continent, asOrg) and the operation prefix applied
 * to normal `push()` calls. `pushRaw()` is the escape hatch for
 * fully-qualified Cloudflare analytics metrics where the measurement
 * name and tags already come from the upstream dataset.
 */
export class CloudflareMetricsRepository implements IMetricsRepository {
  private readonly defaultTags: Record<string, string>;

  constructor(
    private operationPrefix: string,
    request: Request,
    private metricsProviders: IMetricsProviderRepository[],
    environment?: string,
  ) {
    const cf = request.cf as IncomingRequestCfProperties | undefined;
    this.defaultTags = {
      environment: environment ?? '',
      continent: cf?.continent ?? '',
      colo: cf?.colo ?? '',
      asOrg: cf?.asOrganization ?? '',
    };
  }

  monitorAsyncFunction<T extends AsyncFn>(
    operation: Operation,
    call: T,
    options: MonitorOptions = {},
  ): (...args: Parameters<T>) => Promise<Awaited<ReturnType<T>>> {
    operation = { ...operation, tags: { ...operation.tags, ...this.defaultTags } };
    return monitorAsyncFunction(
      this.operationPrefix,
      operation,
      call,
      (metric) => {
        for (const provider of this.metricsProviders) {
          provider.pushMetric(metric);
        }
      },
      options,
    );
  }

  push(metric: Metric) {
    metric.prefixName(this.operationPrefix);
    metric.addTags(this.defaultTags);
    for (const provider of this.metricsProviders) {
      provider.pushMetric(metric);
    }
  }

  /**
   * Push a metric without prefixing it or merging in default tags. Used for
   * Cloudflare analytics data where the measurement name is fully qualified
   * (e.g. `cf_workers_invocations`) and the tags come from the upstream
   * dataset dimensions rather than the running worker's request context.
   */
  pushRaw(metric: Metric) {
    for (const provider of this.metricsProviders) {
      provider.pushMetric(metric);
    }
  }
}
