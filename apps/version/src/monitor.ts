import { Metric } from './metrics.js';

export type AsyncFn = (...args: any[]) => Promise<any>;
export type Class = { new (...args: any[]): any };
export type Operation = { name: string; tags?: Record<string, string> };
export type MonitorOptions = { monitorInvocations?: boolean; acceptedErrors?: Class[] };

export function monitorAsyncFunction<T extends AsyncFn>(
  operationPrefix: string,
  operation: Operation,
  call: T,
  metricsWriteCallback: (metric: Metric) => void,
  options: MonitorOptions = {},
): (...args: Parameters<T>) => Promise<Awaited<ReturnType<T>>> {
  const { name: operationName, tags = {} } = operation;
  const { monitorInvocations = true, acceptedErrors = [] } = options;

  return async (...args: Parameters<T>) => {
    const metric = Metric.create(`${operationPrefix}_${operationName}`);
    metric.addTags(tags);

    if (monitorInvocations) {
      metric.intField('invocation', 1);
    }

    try {
      return await call(...args);
    } catch (error) {
      if (!acceptedErrors.some((acceptedError) => error instanceof acceptedError)) {
        console.error(error, `${operationName}_errors`);
        metric.intField('errors', 1);
      }
      throw error;
    } finally {
      metric.durationField('duration');
      metricsWriteCallback(metric);
    }
  };
}
