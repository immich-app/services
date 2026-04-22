import type { IMetricsProviderRepository } from './metric-providers.js';
import { Metric } from './metric.js';
import { type AsyncFn, type MonitorOptions, type Operation, monitorAsyncFunction } from './monitor.js';

export interface IMetricsRepository {
  monitorAsyncFunction<T extends AsyncFn>(
    operation: Operation,
    call: T,
    options?: MonitorOptions,
  ): (...args: Parameters<T>) => Promise<Awaited<ReturnType<T>>>;
  push(metric: Metric): void;
}

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

  // Push without prefixing or merging default tags — for Cloudflare analytics
  // data where measurement names and tags come from the upstream dataset.
  pushRaw(metric: Metric) {
    for (const provider of this.metricsProviders) {
      provider.pushMetric(metric);
    }
  }
}
