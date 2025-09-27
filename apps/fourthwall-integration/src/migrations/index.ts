export interface Migration {
  id: string;
  name: string;
  sql: string;
}

// Migrations are ordered and applied sequentially
// Each migration should be idempotent (use IF NOT EXISTS, etc.)
export const migrations: Migration[] = [
  {
    id: '001_create_migrations_table',
    name: 'Create migrations tracking table',
    sql: `
      CREATE TABLE IF NOT EXISTS migrations (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      )
    `,
  },
  {
    id: '002_create_orders_table',
    name: 'Create orders table',
    sql: `
      CREATE TABLE IF NOT EXISTS orders (
        id TEXT PRIMARY KEY,
        fourthwall_order_id TEXT UNIQUE NOT NULL,
        customer_email TEXT NOT NULL,
        customer_name TEXT NOT NULL,
        shipping_address_line1 TEXT NOT NULL,
        shipping_address_line2 TEXT,
        shipping_city TEXT NOT NULL,
        shipping_state TEXT,
        shipping_postal_code TEXT NOT NULL,
        shipping_country TEXT NOT NULL,
        order_total_cents INTEGER NOT NULL,
        order_currency TEXT NOT NULL,
        status TEXT NOT NULL,
        fulfillment_provider TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `,
  },
  {
    id: '003_create_order_items_table',
    name: 'Create order items table',
    sql: `
      CREATE TABLE IF NOT EXISTS order_items (
        id TEXT PRIMARY KEY,
        order_id TEXT NOT NULL,
        fourthwall_product_id TEXT NOT NULL,
        fourthwall_variant_id TEXT,
        product_name TEXT NOT NULL,
        quantity INTEGER NOT NULL,
        unit_price_cents INTEGER NOT NULL,
        FOREIGN KEY (order_id) REFERENCES orders(id)
      )
    `,
  },
  {
    id: '004_create_fulfillment_orders_table',
    name: 'Create fulfillment orders table',
    sql: `
      CREATE TABLE IF NOT EXISTS fulfillment_orders (
        id TEXT PRIMARY KEY,
        order_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        provider_order_id TEXT,
        status TEXT NOT NULL,
        tracking_number TEXT,
        tracking_url TEXT,
        shipping_carrier TEXT,
        submitted_at TEXT,
        shipped_at TEXT,
        error_message TEXT,
        retry_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (order_id) REFERENCES orders(id)
      )
    `,
  },
  {
    id: '005_create_webhook_events_table',
    name: 'Create webhook events table',
    sql: `
      CREATE TABLE IF NOT EXISTS webhook_events (
        id TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        event_type TEXT NOT NULL,
        event_data TEXT NOT NULL,
        processed_at TEXT,
        error_message TEXT,
        retry_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      )
    `,
  },
  {
    id: '006_create_indexes',
    name: 'Create database indexes for performance',
    sql: `
      CREATE INDEX IF NOT EXISTS idx_orders_fourthwall_id ON orders(fourthwall_order_id);
      CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
      CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders(created_at);
      CREATE INDEX IF NOT EXISTS idx_order_items_order_id ON order_items(order_id);
      CREATE INDEX IF NOT EXISTS idx_fulfillment_orders_order_id ON fulfillment_orders(order_id);
      CREATE INDEX IF NOT EXISTS idx_fulfillment_orders_provider_order_id ON fulfillment_orders(provider_order_id, provider);
      CREATE INDEX IF NOT EXISTS idx_fulfillment_orders_status ON fulfillment_orders(status);
      CREATE INDEX IF NOT EXISTS idx_webhook_events_source ON webhook_events(source);
      CREATE INDEX IF NOT EXISTS idx_webhook_events_processed_at ON webhook_events(processed_at);
      CREATE INDEX IF NOT EXISTS idx_webhook_events_created_at ON webhook_events(created_at);
    `,
  },
  {
    id: '007_create_product_keys_table',
    name: 'Create product keys table with tracking',
    sql: `
      CREATE TABLE IF NOT EXISTS product_keys (
        key_value TEXT PRIMARY KEY,
        key_type TEXT NOT NULL CHECK (key_type IN ('client', 'server')),
        is_claimed BOOLEAN NOT NULL DEFAULT FALSE,
        claimed_at TEXT,
        order_id TEXT NULL,
        customer_email TEXT,
        sent_at TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE SET NULL
      );

      CREATE INDEX IF NOT EXISTS idx_product_keys_type_claimed ON product_keys(key_type, is_claimed);
      CREATE INDEX IF NOT EXISTS idx_product_keys_claimed_at ON product_keys(claimed_at);
      CREATE INDEX IF NOT EXISTS idx_product_keys_order_id ON product_keys(order_id);
      CREATE INDEX IF NOT EXISTS idx_product_keys_customer_email ON product_keys(customer_email);
      CREATE INDEX IF NOT EXISTS idx_product_keys_sent_at ON product_keys(sent_at);
    `,
  },
];
