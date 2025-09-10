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
├── hello/          # Example hello world worker
└── .../           # Other worker applications

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
    path: url.pathname 
  }), 
  {
    status: 404,
    headers: { 
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*'
    }
  }
);
```
