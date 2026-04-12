import { handleFetch } from './handlers/http.js';
import { handleScheduled } from './handlers/scheduled.js';

/**
 * Worker entry point. Wires the exported `fetch` and `scheduled` hooks
 * to the handlers in `./handlers/`. All service construction, DI, and
 * business logic lives in those handler modules — this file exists
 * purely to satisfy the Cloudflare Workers modules-format exports.
 */
export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return handleFetch(request, env, ctx);
  },

  scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    return handleScheduled(controller, env, ctx);
  },
};
