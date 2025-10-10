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
  tracking_uploaded_to_fourthwall: boolean;
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

export type OrderStatus = 'received' | 'processing' | 'fulfilled' | 'cancelled' | 'skipped';
export type FulfillmentStatus =
  | 'pending'
  | 'submitted'
  | 'processing'
  | 'shipped'
  | 'delivered'
  | 'cancelled'
  | 'failed'
  | 'skipped';
export type FulfillmentProvider = 'kunaki' | 'cdclick-europe';
export type WebhookSource = 'fourthwall' | 'cdclick-europe';

// Actual webhook event structure from Fourthwall
export interface FourthwallWebhook {
  id: string; // webhook event ID (e.g., "weve_...")
  webhookId: string; // webhook configuration ID (e.g., "wcon_...")
  shopId: string; // shop ID
  type: string; // e.g., "ORDER_PLACED", "ORDER_UPDATED", etc.
  apiVersion: string; // e.g., "V1"
  createdAt: string; // timestamp
  data?: FourthwallOrderData; // The actual order data for ORDER_PLACED/ORDER_UPDATED
}

// Fourthwall ORDER_PLACED webhook data structure
export interface FourthwallOrderData {
  id: string;
  shopId: string;
  friendlyId: string;
  checkoutId: string;
  promotionId?: string;
  status: string;
  email: string;
  emailMarketingOptIn: boolean;
  username?: string;
  message?: string;
  amounts: {
    subtotal: { value: number; currency: string };
    shipping: { value: number; currency: string };
    tax: { value: number; currency: string };
    donation: { value: number; currency: string };
    discount: { value: number; currency: string };
    total: { value: number; currency: string };
  };
  billing: {
    address: FourthwallAddress;
  };
  shipping: {
    address: FourthwallAddress;
  };
  offers: FourthwallOffer[];
  source?: {
    type: string;
  };
  createdAt: string;
  updatedAt: string;
}

export interface FourthwallAddress {
  name?: string;
  address1?: string;
  address2?: string;
  city?: string;
  state?: string;
  country?: string;
  zip?: string;
  phone?: string;
}

export interface FourthwallOffer {
  id: string;
  name: string;
  slug: string;
  description?: string;
  primaryImage?: {
    id: string;
    url: string;
    width: number;
    height: number;
    transformedUrl?: string;
  };
  variant?: {
    id: string;
    name?: string;
    sku?: string;
    cost?: {
      value: number;
      currency: string;
    };
    price?: {
      value: number;
      currency: string;
    };
    unitCost?: {
      value: number;
      currency: string;
    };
    unitPrice?: {
      value: number;
      currency: string;
    };
    quantity?: number;
    weight?: {
      unit: string;
      value: number;
    };
    dimensions?: {
      unit: string;
      width: number;
      height: number;
      length: number;
    };
    attributes?: any;
    compareAtPrice?: any;
  };
  quantity?: number; // Optional at offer level
  price?: {
    value: number;
    currency: string;
  };
}

// Legacy structure (keeping for backward compatibility if needed)
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
  Tracking_Type?: string;
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

export interface CDClickOrderCreateResponse {
  success: boolean;
  order_id: number;
  errorText: string;
}

export interface CDClickOrderResponse {
  success: boolean;
  errorText: string;
  orders: Array<{
    id: number;
    custom_id: string;
    orderDate: string;
    shipping_address: {
      first_name: string;
      last_name: string;
      email: string;
      address_street: string;
      zip_code: string;
      city: string;
      state_province_code?: string;
      country_code: string;
      phone_number: string;
    };
    isShipped: boolean;
    shipDate?: string;
    courier_name?: string;
    courier_tracking?: string;
    flag: boolean;
    shipping_fee: number;
    box_and_handling_fee: number;
  }>;
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
  EMAIL_QUEUE: Queue;
  FOURTHWALL_USERNAME: string;
  FOURTHWALL_PASSWORD: string;
  FOURTHWALL_USER_USERNAME: string;
  FOURTHWALL_USER_PASSWORD: string;
  KUNAKI_API_USERNAME: string;
  KUNAKI_API_PASSWORD: string;
  CDCLICK_API_KEY: string;
  CDCLICK_IDLE_MODE?: string;
  WEBHOOK_SECRET: string;
  SMTP_HOST: string;
  SMTP_PORT: string;
  SMTP_USER: string;
  SMTP_PASSWORD: string;
  ENVIRONMENT?: string;
}

export interface ProductKey {
  key_value: string;
  activation_key: string;
  key_type: ProductKeyType;
  is_claimed: boolean;
  claimed_at?: string;
  order_id?: string;
  customer_email?: string;
  sent_at?: string;
  created_at: string;
}

export type ProductKeyType = 'client' | 'server';

export interface EmailData {
  to: string;
  subject: string;
  html: string;
  text: string;
}

export interface ProductKeyEmailData {
  orderId: string;
  customerEmail: string;
  customerName: string;
  keyType: ProductKeyType;
  keyValue: string;
  activationKey: string;
}

export interface QueueMessage {
  type: 'webhook' | 'fulfillment' | 'status_check' | 'product_key_email';
  data: any;
  retry_count?: number;
}
