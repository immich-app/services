-- Fourthwall Integration Database Schema

-- Orders table to track incoming orders from Fourthwall
CREATE TABLE orders (
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
    order_currency TEXT NOT NULL DEFAULT 'USD',
    status TEXT NOT NULL DEFAULT 'received', -- received, processing, fulfilled, cancelled
    fulfillment_provider TEXT, -- kunaki, cdclick-europe
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Order items table to track individual products in each order
CREATE TABLE order_items (
    id TEXT PRIMARY KEY,
    order_id TEXT NOT NULL,
    fourthwall_product_id TEXT NOT NULL,
    fourthwall_variant_id TEXT,
    product_name TEXT NOT NULL,
    quantity INTEGER NOT NULL,
    unit_price_cents INTEGER NOT NULL,
    FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE
);

-- Fulfillment orders table to track orders sent to fulfillment providers
CREATE TABLE fulfillment_orders (
    id TEXT PRIMARY KEY,
    order_id TEXT NOT NULL,
    provider TEXT NOT NULL, -- kunaki, cdclick-europe
    provider_order_id TEXT,
    status TEXT NOT NULL DEFAULT 'pending', -- pending, submitted, processing, shipped, delivered, cancelled, failed
    tracking_number TEXT,
    tracking_url TEXT,
    shipping_carrier TEXT,
    submitted_at TEXT,
    shipped_at TEXT,
    error_message TEXT,
    retry_count INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE
);

-- Webhook events table for tracking incoming webhooks
CREATE TABLE webhook_events (
    id TEXT PRIMARY KEY,
    source TEXT NOT NULL, -- fourthwall, cdclick-europe
    event_type TEXT NOT NULL,
    event_data TEXT NOT NULL, -- JSON payload
    processed_at TEXT,
    error_message TEXT,
    retry_count INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Create indexes for better query performance
CREATE INDEX idx_orders_fourthwall_order_id ON orders(fourthwall_order_id);
CREATE INDEX idx_orders_status ON orders(status);
CREATE INDEX idx_orders_created_at ON orders(created_at);

CREATE INDEX idx_order_items_order_id ON order_items(order_id);
CREATE INDEX idx_order_items_fourthwall_product_id ON order_items(fourthwall_product_id);

CREATE INDEX idx_fulfillment_orders_order_id ON fulfillment_orders(order_id);
CREATE INDEX idx_fulfillment_orders_provider ON fulfillment_orders(provider);
CREATE INDEX idx_fulfillment_orders_status ON fulfillment_orders(status);
CREATE INDEX idx_fulfillment_orders_provider_order_id ON fulfillment_orders(provider_order_id);

CREATE INDEX idx_webhook_events_source ON webhook_events(source);
CREATE INDEX idx_webhook_events_event_type ON webhook_events(event_type);
CREATE INDEX idx_webhook_events_processed_at ON webhook_events(processed_at);
CREATE INDEX idx_webhook_events_created_at ON webhook_events(created_at);