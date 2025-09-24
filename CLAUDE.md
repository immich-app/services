# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is the Immich Workers repository - a monorepo for Cloudflare Workers that provide backend/API services. These workers are deployed independently from the frontend applications.

## Common Commands

### Root Level

```bash
pnpm install       # Install all dependencies
pnpm run lint      # Lint all workers (eslint . --max-warnings 0)
pnpm run lint:fix  # Auto-fix linting issues
pnpm run format    # Check formatting with Prettier
pnpm run format:fix # Auto-fix formatting issues
pnpm run test      # Run all tests in all workers
pnpm run check     # Type-check all workers (tsc --noEmit && pnpm -r typecheck)
pnpm run build     # Build all workers (pnpm -r build)
```

### Worker Development

```bash
cd apps/<worker-name>
pnpm run dev    # Start development server with Wrangler
pnpm run build  # Build for production (dry-run deploy to dist/)
pnpm run tail   # Tail production logs
pnpm run test   # Run tests with Vitest
pnpm run check  # Type-check worker (tsc --noEmit)
```

## Architecture

### Repository Structure

```
apps/
├── hello/                   # Example hello world worker
├── fourthwall-integration/  # E-commerce fulfillment integration worker
├── github-approval-check/   # GitHub PR approval checker
└── .../                    # Other worker applications


deployment/
├── modules/       # Terraform modules
│   └── cloudflare/
│       └── workers/
│           └── <worker-name>/  # Worker-specific Terraform config
└── state.hcl      # Terragrunt state configuration

src/
└── lib/           # Shared libraries and utilities (planned)
```

### Worker Structure

Each worker in `apps/<worker-name>/` contains:

- `src/index.ts` - Main worker entry point (exports default with fetch handler)
- `src/index.test.ts` - Worker tests using Vitest
- `wrangler.toml` - Cloudflare Worker configuration
- `package.json` - Worker-specific scripts
- `tsconfig.json` - TypeScript configuration
- `vitest.config.ts` - Test configuration (imports base config)
- `worker-configuration.d.ts` - Environment type definitions (if needed)
- `.dev.vars` - Local development environment variables (gitignored)

### Technology Stack

- **Runtime**: Cloudflare Workers
- **Language**: TypeScript 5.7+
- **Package Manager**: pnpm 10.14+ with workspaces
- **Build Tool**: Wrangler 4.35+
- **Testing**: Vitest 3.0+ with @cloudflare/vitest-pool-workers
- **Linting**: ESLint 9+ with TypeScript-ESLint, Prettier, Unicorn
- **Infrastructure**: Terraform/Terragrunt with PostgreSQL state backend

## Testing

Workers use Vitest with Cloudflare's test utilities. Tests can access the worker via `SELF`:

```typescript
import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

describe('Worker', () => {
  it('should handle request', async () => {
    const response = await SELF.fetch('https://example.com/');
    expect(response.status).toBe(200);
  });
});
```

The base Vitest configuration at `vitest.base.config.ts` uses `@cloudflare/vitest-pool-workers` for proper Worker environment emulation.

## Deployment

### Direct Deployment (Wrangler)

Workers can be deployed directly using Wrangler (not yet configured with deploy scripts):

```bash
cd apps/<worker-name>
wrangler deploy              # Deploy to production
wrangler deploy --env staging # Deploy to staging environment
```

### Infrastructure as Code (Terraform/Terragrunt)

Each worker has a Terraform module in `deployment/modules/cloudflare/workers/<worker-name>/`:

```bash
# Required environment variables
export TF_VAR_tf_state_postgres_conn_str="postgresql://user:pass@host/dbname"
export TF_VAR_env="dev"        # Environment (dev/staging/prod)
export TF_VAR_stage=""          # Stage suffix (optional)
export TF_VAR_app_name="hello"  # Worker app name
export TF_VAR_cloudflare_account_id="your-account-id"

# For Fourthwall integration, also set:
export TF_VAR_fourthwall_username="your_username"
export TF_VAR_fourthwall_password="your_password"
export TF_VAR_webhook_secret="your_webhook_secret"
export TF_VAR_kunaki_api_username="kunaki_username"
export TF_VAR_kunaki_api_password="kunaki_password"
export TF_VAR_cdclick_api_key="cdclick_key"

cd deployment/modules/cloudflare/workers/<worker-name>
terragrunt init
terragrunt plan
terragrunt apply
```

Key Terragrunt/Terraform patterns:

- State stored in PostgreSQL with schema: `services_cloudflare_workers_${app_name}_immich_app_${env}${stage}`
- Remote state references used for shared resources
- Each worker module includes: `terragrunt.hcl`, `variables.tf`, `config.tf`, `worker.tf`, `providers.tf`, `remote-state.tf`

## Environment Configuration

### Local Development

Create `.dev.vars` in the worker directory for local secrets:

```
SECRET_KEY=local_secret
API_ENDPOINT=https://api.example.com
```

### Production Secrets

Use Wrangler to set production secrets:

```bash
wrangler secret put SECRET_KEY
```

Or configure via Terraform in the worker module.

## Creating a New Worker

1. Create directory: `apps/<worker-name>/`
2. Copy structure from `apps/hello/` as template
3. Update `wrangler.toml`:
   - Set `name = "<worker-name>-immich-app"`
   - Configure any KV namespaces, Durable Objects, etc.
4. Implement worker logic in `src/index.ts`
5. Add tests in `src/index.test.ts`
6. Create Terraform module in `deployment/modules/cloudflare/workers/<worker-name>/`
   - Copy from hello worker module as template
   - Update `app_name` in `terragrunt.hcl`

## Common Patterns

### Request Handler Structure

```typescript
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    switch (url.pathname) {
      case '/':
        return new Response(JSON.stringify({ message: 'Hello' }), {
          headers: { 'Content-Type': 'application/json' },
        });
      default:
        return new Response('Not Found', { status: 404 });
    }
  },
};
```

### CORS Headers

All API responses include CORS headers for cross-origin access:

```typescript
headers: {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
}
```

### Error Response Pattern

```typescript
return new Response(
  JSON.stringify({
    error: 'Not Found',
    path: url.pathname,
  }),
  {
    status: 404,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    },
  },
);
```

## Fourthwall Integration Worker

The Fourthwall integration worker (`apps/fourthwall-integration/`) handles e-commerce order fulfillment through multiple providers.

### Architecture Overview

- **Purpose**: Processes e-commerce orders from Fourthwall, routes to appropriate fulfillment providers
- **Providers**: Kunaki (US), CDClick Europe (EU)
- **Queue System**: Uses Cloudflare Queues for webhook and fulfillment processing
- **Database**: D1 for order tracking and webhook event storage
- **Scheduled Tasks**: Cron job every 15 minutes for status updates

### Key Components

```
fourthwall-integration/
├── src/
│   ├── index.ts              # Main worker entry with fetch, queue, and scheduled handlers
│   ├── types/                # TypeScript interfaces for all data structures
│   ├── services/             # Business logic for external APIs
│   │   ├── fourthwall.ts     # Fourthwall API and webhook handling
│   │   ├── kunaki.ts         # Kunaki fulfillment (US)
│   │   ├── cdclick.ts        # CDClick fulfillment (Europe)
│   │   └── fulfillment.ts    # Fulfillment orchestration
│   └── repositories/         # Database access layer
│       ├── order.ts          # Order management
│       ├── fulfillment.ts    # Fulfillment tracking
│       └── webhook.ts        # Webhook event storage
```

### Development Commands

```bash
cd apps/fourthwall-integration
pnpm run dev          # Start development server
pnpm run test         # Run tests
pnpm run check        # TypeScript type checking
pnpm run build        # Build for production
pnpm run tail         # View live logs from deployed worker
```

### Environment Variables

Required secrets for `apps/fourthwall-integration/.dev.vars`:

```
FOURTHWALL_USERNAME=your_username
FOURTHWALL_PASSWORD=your_password
WEBHOOK_SECRET=your_webhook_secret
KUNAKI_API_USERNAME=username
KUNAKI_API_PASSWORD=password
CDCLICK_API_KEY=your_cdclick_key
```

### API Endpoints

- `GET /` - API info endpoint
- `GET /health` - Health check
- `POST /webhook/fourthwall` - Fourthwall webhook receiver
- `POST /webhook/cdclick` - CDClick webhook receiver

### Queue Messages

The worker processes three types of queue messages:
- `webhook` - Process incoming webhooks
- `fulfillment` - Process order fulfillment
- `status_check` - Check fulfillment status updates

### Database Schema

Key tables managed by the worker:
- `orders` - Fourthwall order data
- `order_items` - Line items for each order
- `fulfillment_orders` - Fulfillment provider tracking
- `webhook_events` - Webhook event log and processing status

### Testing

```bash
cd apps/fourthwall-integration
pnpm run test                    # Run all tests
pnpm run test src/services       # Test specific directory
```

### Deployment Notes

- Database migrations should be run before deploying new versions
- Queue bindings must match between `wrangler.toml` and Terraform configs
- Webhook URLs need to be configured in Fourthwall and CDClick dashboards
- Monitor scheduled task execution for status update reliability
