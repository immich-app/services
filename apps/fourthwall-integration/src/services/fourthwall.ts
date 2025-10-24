import { OrderRepository } from '../repositories/index.js';
import { FourthwallOrderAttributes, FourthwallOrderData, FourthwallWebhook, Order } from '../types/index.js';

export class FourthwallService {
  private authHeader: string;
  private userUsername?: string;
  private userPassword?: string;

  constructor(
    username: string,
    password: string,
    private orderRepository: OrderRepository,
    userUsername?: string,
    userPassword?: string,
  ) {
    // Create basic auth header for API key auth
    console.log('[FW-SERVICE] Initializing FourthwallService');
    console.log('[FW-SERVICE] API Username:', username ? 'provided' : 'missing');
    console.log('[FW-SERVICE] API Password:', password ? 'provided' : 'missing');
    console.log('[FW-SERVICE] User Username:', userUsername ? 'provided' : 'missing');
    console.log('[FW-SERVICE] User Password:', userPassword ? 'provided' : 'missing');
    const credentials = btoa(`${username}:${password}`);
    this.authHeader = `Basic ${credentials}`;
    this.userUsername = userUsername;
    this.userPassword = userPassword;
    console.log('[FW-SERVICE] Auth header created');
  }

  async processWebhook(payload: FourthwallWebhook): Promise<void> {
    console.log('[FW-SERVICE] Processing webhook with type:', payload.type);
    console.log('[FW-SERVICE] Webhook ID:', payload.id);

    // Only process ORDER_PLACED events
    if (payload.type !== 'ORDER_PLACED') {
      console.log(`[FW-SERVICE] Ignoring webhook type: ${payload.type}`);
      return;
    }

    if (!payload.data) {
      console.log('[FW-SERVICE] No data in webhook payload');
      return;
    }

    const orderData = payload.data;
    console.log('[FW-SERVICE] Order data extracted from webhook');
    console.log('[FW-SERVICE] Order ID:', orderData.id);
    console.log('[FW-SERVICE] Friendly ID:', orderData.friendlyId);
    console.log('[FW-SERVICE] Customer email:', orderData.email);
    console.log('[FW-SERVICE] Order status:', orderData.status);
    console.log('[FW-SERVICE] Offers count:', orderData.offers?.length);

    console.log('[FW-SERVICE] Checking for existing order with Fourthwall ID:', orderData.id);
    const existingOrder = await this.orderRepository.getOrderByFourthwallId(orderData.id);
    if (existingOrder) {
      console.log(`[FW-SERVICE] Order ${orderData.id} already exists with internal ID ${existingOrder.id}, skipping`);
      return;
    }
    console.log('[FW-SERVICE] No existing order found, creating new order');

    const order = await this.createOrderFromWebhookV2(orderData);
    console.log('[FW-SERVICE] Order created with internal ID:', order.id);

    console.log('[FW-SERVICE] Creating offer items for order');
    if (orderData.offers && orderData.offers.length > 0) {
      for (const [index, offer] of orderData.offers.entries()) {
        console.log(`[FW-SERVICE] Creating offer item ${index + 1}/${orderData.offers.length}:`, offer.name);
        // Quantity is in the variant object for Fourthwall webhooks
        const quantity = offer.variant?.quantity || offer.quantity || 1;
        const unitPrice = offer.variant?.unitPrice?.value || offer.price?.value || 0;

        console.log(`[FW-SERVICE] Item details - Quantity: ${quantity}, Unit Price: ${unitPrice}`);

        await this.orderRepository.createOrderItem({
          order_id: order.id,
          fourthwall_product_id: offer.id,
          fourthwall_variant_id: offer.variant?.id || undefined,
          product_name: offer.variant?.name || offer.name,
          quantity,
          unit_price_cents: Math.round(unitPrice * 100), // Convert to cents
        });
      }
    }

    console.log(
      `[FW-SERVICE] Successfully created order ${order.id} from Fourthwall order ${orderData.id} with ${orderData.offers?.length || 0} items`,
    );
  }

  private async createOrderFromWebhook(orderData: FourthwallOrderAttributes): Promise<Order> {
    console.log('[FW-SERVICE] Creating order from legacy webhook data');
    console.log('[FW-SERVICE] Shipping country:', orderData.shipping_address?.country);
    console.log('[FW-SERVICE] Order total:', orderData.total?.amount, orderData.total?.currency);

    return await this.orderRepository.createOrder({
      fourthwall_order_id: orderData.id,
      customer_email: orderData.customer.email,
      customer_name: orderData.customer.name,
      shipping_address_line1: orderData.shipping_address.line1,
      shipping_address_line2: orderData.shipping_address.line2,
      shipping_city: orderData.shipping_address.city,
      shipping_state: orderData.shipping_address.state,
      shipping_postal_code: orderData.shipping_address.postal_code,
      shipping_country: orderData.shipping_address.country,
      order_total_cents: orderData.total.amount,
      order_currency: orderData.total.currency,
      status: 'received',
    });
  }

  private async createOrderFromWebhookV2(orderData: FourthwallOrderData): Promise<Order> {
    console.log('[FW-SERVICE] Creating order from webhook data V2');
    console.log('[FW-SERVICE] Shipping country:', orderData.shipping?.address?.country);
    console.log('[FW-SERVICE] Order total:', orderData.amounts?.total?.value, orderData.amounts?.total?.currency);

    return await this.orderRepository.createOrder({
      fourthwall_order_id: orderData.id,
      customer_email: orderData.email,
      customer_name:
        orderData.shipping?.address?.name || orderData.billing?.address?.name || orderData.username || 'Unknown',
      shipping_address_line1: orderData.shipping?.address?.address1 || '',
      shipping_address_line2: orderData.shipping?.address?.address2 || undefined,
      shipping_city: orderData.shipping?.address?.city || '',
      shipping_state: orderData.shipping?.address?.state || undefined,
      shipping_postal_code: orderData.shipping?.address?.zip || '',
      shipping_country: orderData.shipping?.address?.country || '',
      order_total_cents: Math.round((orderData.amounts?.total?.value || 0) * 100), // Convert to cents
      order_currency: orderData.amounts?.total?.currency || 'USD',
      status: 'received',
      fulfillment_provider: undefined, // Explicitly set to undefined initially
    });
  }

  async validateWebhookSignature(payload: string, signature: string, secret: string): Promise<boolean> {
    console.log('[FW-SERVICE] Validating webhook signature');
    console.log('[FW-SERVICE] Signature provided:', signature ? 'yes' : 'no');
    console.log('[FW-SERVICE] Secret provided:', secret ? 'yes' : 'no');
    console.log('[FW-SERVICE] Payload length:', payload.length);

    try {
      const encoder = new TextEncoder();
      const keyData = encoder.encode(secret);
      const data = encoder.encode(payload);

      const key = await crypto.subtle.importKey('raw', keyData, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);

      const signature_buffer = await crypto.subtle.sign('HMAC', key, data);
      const signature_array = new Uint8Array(signature_buffer);

      // Fourthwall uses base64 encoding, not hex
      const expected_signature = btoa(String.fromCodePoint(...signature_array));

      console.log('[FW-SERVICE] Expected signature (base64):', expected_signature);
      console.log('[FW-SERVICE] Provided signature:', signature);

      // Use constant-time comparison for security
      const isValid = expected_signature === signature;
      console.log('[FW-SERVICE] Signature validation result:', isValid);

      return isValid;
    } catch (error) {
      console.error('[FW-SERVICE] Error validating webhook signature:', error);
      console.error('[FW-SERVICE] Error stack:', error instanceof Error ? error.stack : 'No stack');
      return false;
    }
  }

  async getOrder(orderId: string): Promise<any> {
    console.log('[FW-SERVICE] Fetching order from Fourthwall API:', orderId);

    try {
      const url = `https://api.fourthwall.com/v1/orders/${orderId}`;
      console.log('[FW-SERVICE] Making GET request to:', url);

      const response = await fetch(url, {
        headers: {
          Authorization: this.authHeader,
          'Content-Type': 'application/json',
        },
      });

      console.log('[FW-SERVICE] Response status:', response.status);

      if (!response.ok) {
        console.error('[FW-SERVICE] Failed to fetch order. Status:', response.status);
        throw new Error(`Failed to fetch order: ${response.status}`);
      }

      const data = await response.json();
      console.log('[FW-SERVICE] Successfully fetched order data');
      return data;
    } catch (error) {
      console.error(`[FW-SERVICE] Error fetching order ${orderId}:`, error);
      console.error('[FW-SERVICE] Error stack:', error instanceof Error ? error.stack : 'No stack');
      throw error;
    }
  }

  /**
   * Get Basic Auth header for user API access
   */
  private getUserAuthHeader(): string {
    console.log('[FW-SERVICE] Getting user auth header');

    if (!this.userUsername || !this.userPassword) {
      throw new Error('User credentials not provided - cannot authenticate for CSV upload');
    }

    const credentials = btoa(`${this.userUsername}:${this.userPassword}`);
    return `Basic ${credentials}`;
  }

  /**
   * Upload tracking information via CSV to Fourthwall
   * @param trackingData Array of tracking info for orders
   */
  async uploadTrackingCsv(trackingData: Array<{
    orderId: string;
    variantId: string;
    sku: string;
    quantity: number;
    trackingNumber: string;
    carrier: string;
    shippingAddress: string;
    shippingCountry: string;
  }>): Promise<{ errors: string[]; fulfilledOrderIds: string[] }> {
    console.log('[FW-SERVICE] Uploading tracking CSV');
    console.log('[FW-SERVICE] Number of orders:', trackingData.length);

    if (trackingData.length === 0) {
      console.log('[FW-SERVICE] No tracking data to upload');
      return { errors: [], fulfilledOrderIds: [] };
    }

    try {
      // Get Basic Auth header
      const authHeader = this.getUserAuthHeader();

      // Generate CSV content
      const csvContent = this.generateTrackingCsv(trackingData);
      console.log('[FW-SERVICE] Generated CSV with', csvContent.split('\n').length - 1, 'rows');
      console.log('[FW-SERVICE] CSV content:');
      console.log(csvContent);

      // Create FormData for multipart upload
      const boundary = '----WebKitFormBoundary' + Math.random().toString(36).slice(2);
      const formData = this.createMultipartFormData(csvContent, boundary);

      const url = 'https://api.fourthwall.com/api/fulfillments/csv';
      console.log('[FW-SERVICE] Uploading to:', url);

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': authHeader,
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
        },
        body: formData,
      });

      console.log('[FW-SERVICE] Upload response status:', response.status);

      if (!response.ok) {
        const errorText = await response.text();
        console.error('[FW-SERVICE] Failed to upload CSV. Status:', response.status);
        console.error('[FW-SERVICE] Error response:', errorText);
        throw new Error(`Failed to upload tracking CSV: ${response.status} - ${errorText}`);
      }

      const result = await response.json() as { errors: string[]; fulfilledOrderIds: string[] };
      console.log('[FW-SERVICE] Upload successful');
      console.log('[FW-SERVICE] Full response from Fourthwall:');
      console.log(JSON.stringify(result, null, 2));
      console.log('[FW-SERVICE] Fulfilled orders:', result.fulfilledOrderIds?.length || 0);
      console.log('[FW-SERVICE] Errors:', result.errors?.length || 0);

      if (result.errors && result.errors.length > 0) {
        console.log('[FW-SERVICE] Upload errors:', result.errors);
      }

      return result;
    } catch (error) {
      console.error('[FW-SERVICE] Error uploading tracking CSV:', error);
      console.error('[FW-SERVICE] Error stack:', error instanceof Error ? error.stack : 'No stack');
      throw error;
    }
  }

  /**
   * Generate CSV content from tracking data
   */
  /**
   * Escape a CSV field value
   */
  private escapeCsvField(value: string): string {
    // If the value contains comma, newline, or double quote, wrap it in quotes and escape quotes
    if (value.includes(',') || value.includes('\n') || value.includes('"')) {
      return `"${value.replaceAll('"', '""')}"`;
    }
    return value;
  }

  private generateTrackingCsv(trackingData: Array<{
    orderId: string;
    variantId: string;
    sku: string;
    quantity: number;
    trackingNumber: string;
    carrier: string;
    shippingAddress: string;
    shippingCountry: string;
  }>): string {
    console.log('[FW-SERVICE] Generating CSV content');

    // CSV header - all 32 columns are required
    const headers = [
      'ORDER ID',
      'ORDER STATUS',
      'FULFILLMENT SERVICE',
      'SHIPPING METHOD',
      'ORDERED BY',
      'SHIPPING NAME',
      'SHIPPING ADDRESS 1',
      'SHIPPING ADDRESS 2',
      'SHIPPING CITY',
      'SHIPPING STATE',
      'SHIPPING POSTAL CODE',
      'SHIPPING COUNTRY',
      'SHIPPING PHONE NUMBER',
      'ITEM NAME',
      'QUANTITY',
      'ITEM CODE/SKU',
      'ITEM ID',
      'ITEM PRICE',
      'CURRENCY',
      'ITEM WEIGHT',
      'WEIGHT UNIT',
      'COLOR',
      'SIZE',
      'CUSTOM ATTRIBUTE',
      'IMAGE URL',
      'CONTRIBUTION TIME (UTC)',
      'EMAIL',
      'HS CODE',
      'ORIGIN COUNTRY',
      'TAX ID',
      'CARRIER CODE',
      'TRACKING NUMBER',
    ];

    console.log('[FW-SERVICE] CSV has', headers.length, 'columns');

    const rows = [headers.join(',')];

    for (const [index, item] of trackingData.entries()) {
      console.log(`[FW-SERVICE] Processing row ${index + 1}:`);
      console.log(`[FW-SERVICE]   Order ID: ${item.orderId}`);
      console.log(`[FW-SERVICE]   Shipping Address: ${item.shippingAddress}`);
      console.log(`[FW-SERVICE]   Shipping Country: ${item.shippingCountry}`);
      console.log(`[FW-SERVICE]   SKU: ${item.sku}`);
      console.log(`[FW-SERVICE]   Variant ID: ${item.variantId}`);
      console.log(`[FW-SERVICE]   Carrier: ${item.carrier}`);
      console.log(`[FW-SERVICE]   Tracking Number: ${item.trackingNumber}`);
      console.log(`[FW-SERVICE]   Quantity: ${item.quantity}`);

      // Build row with all columns (most empty)
      const row = [
        this.escapeCsvField(item.orderId),                 // ORDER ID
        '',                                                 // ORDER STATUS
        '',                                                 // FULFILLMENT SERVICE
        '',                                                 // SHIPPING METHOD
        '',                                                 // ORDERED BY
        '',                                                 // SHIPPING NAME
        this.escapeCsvField(item.shippingAddress),         // SHIPPING ADDRESS 1
        '',                                                 // SHIPPING ADDRESS 2
        '',                                                 // SHIPPING CITY
        '',                                                 // SHIPPING STATE
        '',                                                 // SHIPPING POSTAL CODE
        this.escapeCsvField(item.shippingCountry),         // SHIPPING COUNTRY
        '',                                                 // SHIPPING PHONE NUMBER
        '',                                                 // ITEM NAME
        item.quantity.toString(),                           // QUANTITY
        this.escapeCsvField(item.sku),                     // ITEM CODE/SKU
        this.escapeCsvField(item.variantId),               // ITEM ID
        '',                                                 // ITEM PRICE
        '',                                                 // CURRENCY
        '',                                                 // ITEM WEIGHT
        '',                                                 // WEIGHT UNIT
        '',                                                 // COLOR
        '',                                                 // SIZE
        '',                                                 // CUSTOM ATTRIBUTE
        '',                                                 // IMAGE URL
        '',                                                 // CONTRIBUTION TIME (UTC)
        '',                                                 // EMAIL
        '',                                                 // HS CODE
        '',                                                 // ORIGIN COUNTRY
        '',                                                 // TAX ID
        this.escapeCsvField(item.carrier),                 // CARRIER CODE
        this.escapeCsvField(item.trackingNumber),          // TRACKING NUMBER
      ];

      console.log(`[FW-SERVICE] Row ${index + 1} has ${row.length} columns`);

      if (row.length !== headers.length) {
        console.error(`[FW-SERVICE] ERROR: Row ${index + 1} has ${row.length} columns but header has ${headers.length}`);
        console.error('[FW-SERVICE] Row data:', JSON.stringify(item));
      }

      const rowString = row.join(',');
      const commaCount = (rowString.match(/,/g) || []).length;
      console.log(`[FW-SERVICE] Row ${index + 1} joined string has ${commaCount} commas (should be ${headers.length - 1})`);

      rows.push(rowString);
    }

    return rows.join('\n');
  }

  /**
   * Create multipart form data for CSV upload
   */
  private createMultipartFormData(csvContent: string, boundary: string): string {
    const parts: string[] = [];

    // Add CSV file part
    parts.push(`--${boundary}\r\n`, 'Content-Disposition: form-data; name="csv"; filename="tracking.csv"\r\n', 'Content-Type: text/csv\r\n', '\r\n', csvContent, '\r\n', `--${boundary}--\r\n`);

    return parts.join('');
  }
}
