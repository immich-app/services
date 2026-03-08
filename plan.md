# Discord Bot Migration Plan: NestJS → Cloudflare Worker + Durable Object

## Overview

Migrate the discord-bot from `immich-app/discord-bot` (NestJS + Express + PostgreSQL) to a Cloudflare Worker with a Durable Object in `apps/discord-bot/` in this repo. The Durable Object will maintain the discord.js WebSocket gateway connection and use its built-in SQLite for storage.

## Architecture

```
CF Worker (fetch handler)                    Durable Object (DiscordBot)
┌─────────────────────────┐                 ┌──────────────────────────────┐
│ Routes:                 │                 │ - discord.js gateway client  │
│  POST /webhooks/github  │──── forwards ──▶│ - SQLite storage (links,     │
│  POST /webhooks/stripe  │    to DO        │   messages, payments, etc.)  │
│  POST /webhooks/fw      │                 │ - Slash commands via gateway │
│  POST /webhooks/gh-stat │                 │ - Event handlers (message,   │
│                         │                 │   thread, reaction)          │
│ Cron triggers:          │                 │ - Cron job execution         │
│  */15 * * * *  (RSS)    │──── alarm() ───▶│ - RSS feed polling           │
│  0 12 * * *    (daily)  │                 │ - Scheduled messages         │
│  etc.                   │                 │ - Report generation          │
└─────────────────────────┘                 └──────────────────────────────┘
```

## Key Design Decisions

1. **Durable Object for discord.js**: The DO provides persistent execution context needed for the discord.js WebSocket gateway. With `nodejs_compat` compatibility flag, discord.js should work (to be validated).

2. **SQLite replaces PostgreSQL**: The DO's built-in SQLite replaces Kysely + PostgreSQL. We'll rewrite the database layer to use the DO's `ctx.storage.sql` API directly.

3. **Worker as HTTP router**: The outer Worker handles incoming HTTP webhooks and cron triggers, forwarding them to the single Durable Object instance.

4. **Dependencies**: discord.js + discordx stay. NestJS, Express, Kysely, pg are removed. lodash and luxon stay. `octokit` stays for GitHub API. `rss-parser` stays. `zulip-js` stays. `semver` stays.

## Implementation Steps

### Step 1: Scaffold the worker

- Create `apps/discord-bot/` with all standard files (package.json, wrangler.toml, tsconfig.json, vitest.config.ts)
- Configure `wrangler.toml` with:
  - Durable Object binding (`DISCORD_BOT`)
  - `nodejs_compat` compatibility flag
  - Cron triggers for scheduled tasks
  - Environment variables (secrets) for bot token, GitHub keys, webhook slugs, etc.
- Add dependencies: `discord.js`, `discordx`, `@discordx/importer`, `octokit`, `luxon`, `lodash`, `rss-parser`, `semver`, `zulip-js`

### Step 2: Create the Durable Object class

- `src/durable-objects/discord-bot.ts` - Main DO class extending `DurableObject`
- Implements `fetch()` for receiving forwarded requests from the Worker
- Implements `alarm()` for scheduled tasks (RSS polling, cron jobs)
- Initializes discord.js client on first request / construction
- Manages SQLite schema via `ctx.storage.sql`

### Step 3: Migrate the database layer

- Create SQLite schema matching the current PostgreSQL tables:
  - `discord_link` (id, name, link, author, usageCount)
  - `discord_message` (id, name, content, lastEditedBy, usageCount)
  - `payment` (id, event_id, amount, currency, status, description, created, livemode, data)
  - `fourthwall_order` (id, discount, tax, shipping, subtotal, total, revenue, profit, username, message, status, testMode, createdAt)
  - `rss_feed` (url, channelId, lastId, profileImageUrl, title)
  - `scheduled_message` (id, name, cronExpression, message, channelId, createdBy)
  - `pull_request` (id, discordThreadId, closedAt)
  - `sponsor` (existing table)
- Create `src/repositories/database.repository.ts` using `ctx.storage.sql` raw SQL instead of Kysely
- Run schema creation on DO construction (CREATE TABLE IF NOT EXISTS)

### Step 4: Migrate repositories (external API clients)

Port these as plain classes (no NestJS decorators):

- `src/repositories/discord.repository.ts` - Discord client wrapper (discord.js + discordx)
- `src/repositories/github.repository.ts` - GitHub API via Octokit
- `src/repositories/zulip.repository.ts` - Zulip API client
- `src/repositories/outline.repository.ts` - Outline API client (uses fetch, minimal changes)
- `src/repositories/fourthwall.repository.ts` - Fourthwall API client (uses fetch)
- `src/repositories/rss.repository.ts` - RSS feed parser
- `src/repositories/holidays.repository.ts` - Holidays API client

### Step 5: Migrate services

Port as plain classes, removing NestJS decorators (`@Injectable`, `@Inject`, `@Cron`):

- `src/services/discord.service.ts` - Core Discord business logic
- `src/services/webhook.service.ts` - Webhook handling (GitHub, Stripe, Fourthwall)
- `src/services/schedule.service.ts` - Scheduled reports (daily/weekly/monthly)
- `src/services/rss.service.ts` - RSS feed management
- `src/services/scheduled-message.service.ts` - User-defined scheduled messages
- `src/services/github.service.ts` - GitHub service layer
- `src/services/zulip.service.ts` - Zulip holiday notifications
- `src/services/database.service.ts` - Database management (simplified for SQLite)

### Step 6: Migrate Discord commands & events

Port as plain classes, adapting discordx decorators:

- `src/discord/commands.ts` - All slash commands
- `src/discord/events.ts` - Gateway events (messageCreate, threadCreate, etc.)
- `src/discord/help-desk.ts` - Help desk functionality
- `src/discord/context-menus.ts` - Context menus (currently empty/commented out)

### Step 7: Create the Worker entry point

- `src/index.ts` - Worker fetch handler that:
  - Routes webhook POSTs to the DO
  - Passes cron triggers to the DO via alarm/fetch
  - Returns health check responses
- Export the DO class for Wrangler

### Step 8: Migrate constants, interfaces, types, and utilities

- `src/constants.ts` - Copy directly (no framework dependencies)
- `src/interfaces/` - Copy all interfaces, remove NestJS-specific types
- `src/dtos/` - Copy webhook DTOs, remove class-validator/class-transformer decorators
- `src/util.ts` - Copy utility functions

### Step 9: Wire up dependency injection manually

Since NestJS DI is gone, create a simple service container in the DO:

- Instantiate repositories with config
- Instantiate services with repository dependencies
- Pass services to Discord command/event handlers

### Step 10: Add Terraform/Terragrunt deployment support for Durable Objects

- Create `deployment/modules/cloudflare/workers/discord-bot/`
- Key additions to `worker.tf`:
  - `cloudflare_workers_for_platforms_dispatch_namespace` or use `durable_object_namespace` binding
  - The `cloudflare_worker_version` resource needs a `durable_object_namespace` binding
  - Configure the DO class name and environment
- Add cron trigger configuration
- Add secret bindings for all environment variables
- Copy standard files (config.tf, providers.tf, remote-state.tf, variables.tf, locals.tf)
- Create terragrunt.hcl with `app_name = "discord-bot"`

### Step 11: Tests

- Set up vitest with `@cloudflare/vitest-pool-workers`
- Test webhook routing
- Test database operations (SQLite)
- Test service logic with mocked dependencies

### Step 12: Environment variables / secrets

The following need to be configured as Worker secrets:

- `BOT_TOKEN` - Discord bot token
- `GITHUB_SLUG` - GitHub webhook slug
- `GITHUB_STATUS_SLUG` - GitHub status webhook slug
- `GITHUB_APP_ID` - GitHub App ID
- `GITHUB_INSTALLATION_ID` - GitHub installation ID
- `GITHUB_PRIVATE_KEY` - GitHub App private key
- `STRIPE_PAYMENT_SLUG` - Stripe webhook slug
- `FOURTHWALL_SLUG` - Fourthwall webhook slug
- `FOURTHWALL_USER` - Fourthwall auth user
- `FOURTHWALL_PASSWORD` - Fourthwall auth password
- `OUTLINE_API_KEY` - Outline API key
- `ZULIP_BOT_USERNAME`, `ZULIP_BOT_API_KEY` - Zulip bot creds
- `ZULIP_USER_USERNAME`, `ZULIP_USER_API_KEY` - Zulip user creds
- `ZULIP_DOMAIN` - Zulip domain

## Risks & Mitigations

1. **discord.js in DO**: The biggest risk. discord.js is large (~20MB with deps) and built for Node.js. With `nodejs_compat` most APIs should work, but WebSocket behavior in DOs may differ. **Mitigation**: Test early in Step 2. If discord.js doesn't work, we can fall back to a lightweight Discord gateway implementation or HTTP interactions.

2. **DO memory limits**: Durable Objects have 128MB memory limit. discord.js + all dependencies may push this. **Mitigation**: Monitor memory usage, consider lazy-loading modules.

3. **DO CPU limits**: DOs have 30-second CPU time limit per request (with 15-minute wall clock). Long-running operations like backfilling PRs may need to be chunked. **Mitigation**: Use alarms for long operations.

4. **SQLite vs PostgreSQL**: Some queries use PostgreSQL-specific features. `BETWEEN` with dates, `SUM`, `COUNT` work in SQLite. UUID generation needs to use `randomUUID()` instead of PostgreSQL's `uuid-ossp`. **Mitigation**: Test all queries in SQLite.

5. **zulip-js**: This package may not work in Workers due to Node.js dependencies. **Mitigation**: Replace with raw fetch calls to the Zulip API if needed.

## What stays in the old repo (for now)

Nothing - this is a full migration. Once validated, the old discord-bot repo can be archived.
