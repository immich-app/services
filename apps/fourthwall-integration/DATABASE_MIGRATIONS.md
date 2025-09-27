# Database Migrations

This worker uses an automatic database migration system for Cloudflare D1.

## How It Works

1. **Automatic Execution**: Migrations run automatically on the first request to the worker after deployment
2. **Idempotent**: Each migration uses `IF NOT EXISTS` clauses and is tracked in a `migrations` table
3. **Ordered**: Migrations run in sequence based on their ID
4. **Safe**: Failed migrations don't prevent the worker from starting (logged but not fatal)

## Migration Files

Migrations are defined in `/src/migrations/index.ts` as an ordered array.

Each migration has:

- `id`: Unique identifier (e.g., `001_create_orders_table`)
- `name`: Human-readable description
- `sql`: SQL statements to execute (can be multiple statements separated by semicolons)

## Adding New Migrations

1. Add a new migration object to the `migrations` array in `/src/migrations/index.ts`
2. Use a sequential ID (e.g., `007_add_new_column`)
3. Always use `IF NOT EXISTS` for CREATE statements
4. Make migrations additive (don't drop/modify existing structures)

Example:

```typescript
{
  id: '007_add_customer_phone',
  name: 'Add customer phone to orders table',
  sql: `
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS customer_phone TEXT;
  `,
}
```

## API Endpoints

### Health Check

`GET /health` - Returns migration status in response:

```json
{
  "status": "healthy",
  "database": {
    "migrations_initialized": true,
    "needs_migration": false
  }
}
```

### Migration Status

`GET /admin/migrations` - Shows all applied migrations:

```json
{
  "initialized": true,
  "applied_migrations": [
    {
      "id": "001_create_migrations_table",
      "name": "Create migrations tracking table",
      "applied_at": "2024-01-01T00:00:00Z"
    }
  ],
  "total_migrations": 6
}
```

### Manual Migration Trigger

`POST /admin/migrations` - Manually trigger migration execution

## Database Schema

The migration system creates these tables:

### migrations

- `id` TEXT PRIMARY KEY - Migration identifier
- `name` TEXT NOT NULL - Migration name
- `applied_at` TEXT NOT NULL - When migration was applied

### orders

- `id` TEXT PRIMARY KEY
- `fourthwall_order_id` TEXT UNIQUE NOT NULL
- `customer_email` TEXT NOT NULL
- `customer_name` TEXT NOT NULL
- `shipping_address_line1` TEXT NOT NULL
- `shipping_address_line2` TEXT
- `shipping_city` TEXT NOT NULL
- `shipping_state` TEXT
- `shipping_postal_code` TEXT NOT NULL
- `shipping_country` TEXT NOT NULL
- `order_total_cents` INTEGER NOT NULL
- `order_currency` TEXT NOT NULL
- `status` TEXT NOT NULL
- `fulfillment_provider` TEXT
- `created_at` TEXT NOT NULL
- `updated_at` TEXT NOT NULL

### order_items

- `id` TEXT PRIMARY KEY
- `order_id` TEXT NOT NULL (FK -> orders)
- `fourthwall_product_id` TEXT NOT NULL
- `fourthwall_variant_id` TEXT
- `product_name` TEXT NOT NULL
- `quantity` INTEGER NOT NULL
- `unit_price_cents` INTEGER NOT NULL

### fulfillment_orders

- `id` TEXT PRIMARY KEY
- `order_id` TEXT NOT NULL (FK -> orders)
- `provider` TEXT NOT NULL
- `provider_order_id` TEXT
- `status` TEXT NOT NULL
- `tracking_number` TEXT
- `tracking_url` TEXT
- `shipping_carrier` TEXT
- `submitted_at` TEXT
- `shipped_at` TEXT
- `error_message` TEXT
- `retry_count` INTEGER NOT NULL DEFAULT 0
- `created_at` TEXT NOT NULL
- `updated_at` TEXT NOT NULL

### webhook_events

- `id` TEXT PRIMARY KEY
- `source` TEXT NOT NULL
- `event_type` TEXT NOT NULL
- `event_data` TEXT NOT NULL
- `processed_at` TEXT
- `error_message` TEXT
- `retry_count` INTEGER NOT NULL DEFAULT 0
- `created_at` TEXT NOT NULL

## Troubleshooting

### Migrations Not Running

1. Check worker logs for `[MIGRATION]` entries
2. Visit `/admin/migrations` to see status
3. POST to `/admin/migrations` to manually trigger

### Migration Errors

- Migrations are non-fatal - worker continues even if migration fails
- Check logs for detailed error messages
- Each migration is atomic - partial migrations are rolled back

### Resetting Database

To completely reset (development only):

1. Delete the D1 database in Cloudflare Dashboard
2. Recreate the database
3. Redeploy the worker
