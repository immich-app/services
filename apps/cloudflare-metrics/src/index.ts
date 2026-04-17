import { handleFetch } from './handlers/http.js';
import { handleScheduled } from './handlers/scheduled.js';

export const BUILD_MARKER = 'usage-model-regression-test-1';

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return handleFetch(request, env, ctx);
  },

  scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    return handleScheduled(controller, env, ctx);
  },
};
