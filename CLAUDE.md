# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is the Immich Workers repository - a monorepo for Cloudflare Workers that provide backend/API services. These workers are deployed independently from the frontend applications.

## Common Commands

### Root Level
```bash
pnpm install       # Install all dependencies
pnpm run lint      # Lint all workers
pnpm run format    # Check formatting
pnpm run test      # Run all tests
pnpm run typecheck # Type-check all workers
```

### Worker Development
```bash
cd apps/<worker-name>
pnpm install       # Install worker dependencies
pnpm run dev       # Start development server
pnpm run build     # Build for production
pnpm run deploy    # Deploy directly to Cloudflare
pnpm run test      # Run worker tests
```

## Architecture

### Repository Structure
```
apps/
├── hello/         # Example hello world worker
├── datasets/      # Datasets API worker
└── .../          # Other worker applications

deployment/
├── modules/       # Terraform modules
│   └── cloudflare/
│       └── workers/
│           └── generic/  # Reusable worker module
└── terragrunt/    # Terragrunt configurations
    ├── dev/       # Development environment
    ├── staging/   # Staging environment
    └── prod/      # Production environment

src/
└── lib/          # Shared libraries and utilities
```

### Worker Structure
Each worker in `apps/<worker-name>/` contains:
- `src/index.ts` - Main worker entry point
- `wrangler.toml` - Cloudflare Worker configuration
- `package.json` - Dependencies and scripts
- `tsconfig.json` - TypeScript configuration
- `vitest.config.ts` - Test configuration
- `worker-configuration.d.ts` - Environment type definitions

### Technology Stack
- **Runtime**: Cloudflare Workers
- **Language**: TypeScript
- **Build Tool**: Wrangler CLI
- **Testing**: Vitest with Miniflare
- **Infrastructure**: Terraform/Terragrunt
- **Package Manager**: pnpm with workspaces

## Deployment

### Direct Deployment (Wrangler)
```bash
cd apps/<worker-name>
pnpm run deploy              # Deploy to default environment
pnpm run deploy:staging      # Deploy to staging
pnpm run deploy:production   # Deploy to production
```

### Infrastructure as Code (Terraform/Terragrunt)
```bash
# Set up required environment variables
export TF_VAR_tf_state_postgres_conn_str="postgresql://user:pass@host/dbname"
export TF_VAR_env="dev"              # Environment (dev/staging/prod)
export TF_VAR_stage="dev"            # Stage
export TF_VAR_app_name="hello"       # App name
export TF_VAR_cloudflare_account_id="your-account-id"

# Deploy with Terragrunt
cd deployment/modules/cloudflare/workers/<worker-name>
terragrunt init
terragrunt plan
terragrunt apply
```

The deployment uses the same Terragrunt pattern as other Immich infrastructure:
- PostgreSQL backend for state storage
- Remote state references for API keys and account info
- Schema naming: `cloudflare_workers_immich_app_${app_name}_${env}${stage}`

## Environment Configuration

### Local Development
Create `.dev.vars` in the worker directory:
```
SECRET_KEY=local_secret
API_ENDPOINT=https://api.example.com
```

### Production Secrets
Use Wrangler or Terraform to set production secrets:
```bash
wrangler secret put SECRET_KEY
```

## Creating a New Worker

1. Create worker directory: `apps/<worker-name>/`
2. Copy structure from `apps/hello/` as template
3. Update `wrangler.toml` with worker name
4. Implement worker logic in `src/index.ts`
5. Add Terragrunt config if using IaC deployment

## Testing

Workers use Vitest with Miniflare for testing:
```bash
cd apps/<worker-name>
pnpm run test        # Run tests once
pnpm run test:watch  # Run tests in watch mode
```

## Common Patterns

### Request Handling
```typescript
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // Handle request
  }
}
```

### CORS Headers
```typescript
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};
```

### Error Handling
```typescript
try {
  // Worker logic
} catch (error) {
  return new Response(JSON.stringify({ error: 'Internal Server Error' }), {
    status: 500,
    headers: { 'Content-Type': 'application/json' }
  });
}
```