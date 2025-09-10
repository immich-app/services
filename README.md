# Immich Workers

Monorepo for Immich Cloudflare Workers (backend-only/API services).

## Structure

```
apps/
├── hello/          # Hello world example worker
├── datasets/       # Datasets API worker
└── .../           # Other worker applications

deployment/
├── modules/        # Terraform modules
└── terragrunt/     # Terragrunt configurations

src/
└── lib/           # Shared libraries and utilities
```

## Development

### Setup

```bash
npm install
```

### Working with Individual Workers

```bash
cd apps/<worker-name>
npm install
npm run dev     # Start development server
npm run test    # Run tests
npm run build   # Build for production
npm run deploy  # Deploy to Cloudflare
```

### Global Commands

```bash
npm run lint        # Lint all workers
npm run format      # Check formatting
npm run test        # Run all tests
npm run typecheck   # Type-check all workers
```

## Deployment

### Using Wrangler (Direct)

```bash
cd apps/<worker-name>
npm run deploy
```

### Using Terraform/Terragrunt

```bash
cd deployment/terragrunt/<environment>/<worker-name>
terragrunt plan
terragrunt apply
```

## Creating a New Worker

1. Create directory: `apps/<worker-name>/`
2. Add `package.json`, `wrangler.toml`, `tsconfig.json`
3. Create source in `src/index.ts`
4. Add terraform module in `deployment/modules/cloudflare/workers/<worker-name>/`
5. Add terragrunt config in `deployment/terragrunt/`

## Environment Variables

Workers use `.dev.vars` for local development and Cloudflare secrets for production.

Example `.dev.vars`:

```
MY_SECRET=secret_value
API_KEY=test_key
```
