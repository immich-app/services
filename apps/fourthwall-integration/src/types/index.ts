export interface Order {
  id: string;
  fourthwall_order_id: string;
  customer_email: string;
  customer_name: string;
  shipping_address_line1: string;
  shipping_address_line2?: string;
  shipping_city: string;
  shipping_state?: string;
  shipping_postal_code: string;
  shipping_country: string;
  order_total_cents: number;
  order_currency: string;
  status: OrderStatus;
  fulfillment_provider?: FulfillmentProvider;
  created_at: string;
  updated_at: string;
}

export interface OrderItem {
  id: string;
  order_id: string;
  fourthwall_product_id: string;
  fourthwall_variant_id?: string;
  product_name: string;
  quantity: number;
  unit_price_cents: number;
}

export interface FulfillmentOrder {
  id: string;
  order_id: string;
  provider: FulfillmentProvider;
  provider_order_id?: string;
  status: FulfillmentStatus;
  tracking_number?: string;
  tracking_url?: string;
  shipping_carrier?: string;
  submitted_at?: string;
  shipped_at?: string;
  error_message?: string;
  retry_count: number;
  created_at: string;
  updated_at: string;
}

export interface WebhookEvent {
  id: string;
  source: WebhookSource;
  event_type: string;
  event_data: string;
  processed_at?: string;
  error_message?: string;
  retry_count: number;
  created_at: string;
}

export type OrderStatus = 'received' | 'processing' | 'fulfilled' | 'cancelled';
export type FulfillmentStatus =
  | 'pending'
  | 'submitted'
  | 'processing'
  | 'shipped'
  | 'delivered'
  | 'cancelled'
  | 'failed';
export type FulfillmentProvider = 'kunaki' | 'cdclick-europe';
export type WebhookSource = 'fourthwall' | 'cdclick-europe';

export interface FourthwallWebhook {
  id: string;
  type: string;
  data: {
    id: string;
    type: string;
    attributes: FourthwallOrderAttributes;
  };
  created_at: string;
}

export interface FourthwallOrderAttributes {
  id: string;
  status: string;
  total: {
    amount: number;
    currency: string;
  };
  customer: {
    email: string;
    name: string;
  };
  shipping_address: {
    line1: string;
    line2?: string;
    city: string;
    state?: string;
    postal_code: string;
    country: string;
  };
  line_items: FourthwallLineItem[];
}

export interface FourthwallLineItem {
  id: string;
  product_id: string;
  variant_id?: string;
  name: string;
  quantity: number;
  price: {
    amount: number;
    currency: string;
  };
}

export interface CDClickWebhook {
  order_id: string;
  status: string;
  tracking_number?: string;
  tracking_url?: string;
  carrier?: string;
  shipped_at?: string;
  event_type: string;
}

export interface KunakiOrderRequest {
  Product_Id: string;
  Quantity: number;
  Ship_Name: string;
  Ship_Address: string;
  Ship_Address_2?: string;
  Ship_City: string;
  Ship_State?: string;
  Ship_Postal_Code: string;
  Ship_Country: string;
  Order_Id?: string;
}

export interface KunakiOrderResponse {
  Order_Id: string;
  Status: string;
  Error?: string;
}

export interface KunakiStatusResponse {
  Order_Id: string;
  Status: string;
  Tracking_Number?: string;
  Shipping_Date?: string;
  Error?: string;
}

export interface CDClickOrderRequest {
  reference: string;
  recipient: {
    name: string;
    address: {
      street: string;
      street2?: string;
      city: string;
      state?: string;
      zip: string;
      country: string;
    };
  };
  items: CDClickOrderItem[];
}

export interface CDClickOrderItem {
  sku: string;
  quantity: number;
}

export interface CDClickOrderResponse {
  id: string;
  reference: string;
  status: string;
  tracking?: {
    number: string;
    url: string;
    carrier: string;
  };
}

export interface FulfillmentResult {
  success: boolean;
  provider_order_id?: string;
  error?: string;
  tracking_number?: string;
  tracking_url?: string;
  carrier?: string;
}

export interface Env {
  DB: D1Database;
  WEBHOOK_QUEUE: Queue;
  FULFILLMENT_QUEUE: Queue;
  FOURTHWALL_API_KEY: string;
  KUNAKI_API_USERNAME: string;
  KUNAKI_API_PASSWORD: string;
  CDCLICK_API_KEY: string;
  WEBHOOK_SECRET: string;
}

export interface QueueMessage {
  type: 'webhook' | 'fulfillment' | 'status_check';
  data: any;
  retry_count?: number;
}
