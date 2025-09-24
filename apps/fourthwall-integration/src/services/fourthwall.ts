import { OrderRepository } from '../repositories/index.js';
import { FourthwallOrderAttributes, FourthwallWebhook, Order } from '../types/index.js';

export class FourthwallService {
  private authHeader: string;

  constructor(
    username: string,
    password: string,
    private orderRepository: OrderRepository,
  ) {
    // Create basic auth header
    console.log('[FW-SERVICE] Initializing FourthwallService');
    console.log('[FW-SERVICE] Username:', username ? 'provided' : 'missing');
    console.log('[FW-SERVICE] Password:', password ? 'provided' : 'missing');
    const credentials = btoa(`${username}:${password}`);
    this.authHeader = `Basic ${credentials}`;
    console.log('[FW-SERVICE] Auth header created');
  }

  async processWebhook(payload: FourthwallWebhook): Promise<void> {
    console.log('[FW-SERVICE] Processing webhook with type:', payload.type);
    console.log('[FW-SERVICE] Webhook ID:', payload.data?.attributes?.id);
    
    if (payload.type !== 'order.paid') {
      console.log(`[FW-SERVICE] Ignoring non-order.paid webhook type: ${payload.type}`);
      return;
    }

    const orderData = payload.data.attributes;
    console.log('[FW-SERVICE] Order data extracted from webhook');
    console.log('[FW-SERVICE] Order ID:', orderData.id);
    console.log('[FW-SERVICE] Customer:', orderData.customer?.email);
    console.log('[FW-SERVICE] Line items count:', orderData.line_items?.length);

    console.log('[FW-SERVICE] Checking for existing order with Fourthwall ID:', orderData.id);
    const existingOrder = await this.orderRepository.getOrderByFourthwallId(orderData.id);
    if (existingOrder) {
      console.log(`[FW-SERVICE] Order ${orderData.id} already exists with internal ID ${existingOrder.id}, skipping`);
      return;
    }
    console.log('[FW-SERVICE] No existing order found, creating new order');

    const order = await this.createOrderFromWebhook(orderData);
    console.log('[FW-SERVICE] Order created with internal ID:', order.id);

    console.log('[FW-SERVICE] Creating line items for order');
    for (const [index, lineItem] of orderData.line_items.entries()) {
      console.log(`[FW-SERVICE] Creating line item ${index + 1}/${orderData.line_items.length}:`, lineItem.name);
      await this.orderRepository.createOrderItem({
        order_id: order.id,
        fourthwall_product_id: lineItem.product_id,
        fourthwall_variant_id: lineItem.variant_id,
        product_name: lineItem.name,
        quantity: lineItem.quantity,
        unit_price_cents: lineItem.price.amount,
      });
    }

    console.log(`[FW-SERVICE] Successfully created order ${order.id} from Fourthwall order ${orderData.id} with ${orderData.line_items.length} line items`);
  }

  private async createOrderFromWebhook(orderData: FourthwallOrderAttributes): Promise<Order> {
    console.log('[FW-SERVICE] Creating order from webhook data');
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

  async updateOrderWithTracking(
    fourthwallOrderId: string,
    trackingNumber: string,
    trackingUrl?: string,
    carrier?: string,
  ): Promise<void> {
    console.log('[FW-SERVICE] Updating order with tracking');
    console.log('[FW-SERVICE] Fourthwall Order ID:', fourthwallOrderId);
    console.log('[FW-SERVICE] Tracking Number:', trackingNumber);
    console.log('[FW-SERVICE] Tracking URL:', trackingUrl || 'not provided');
    console.log('[FW-SERVICE] Carrier:', carrier || 'not provided');
    
    try {
      const url = `https://api.fourthwall.com/v1/orders/${fourthwallOrderId}/fulfillment`;
      console.log('[FW-SERVICE] Making POST request to:', url);
      
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: this.authHeader,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          tracking_number: trackingNumber,
          tracking_url: trackingUrl,
          carrier,
          status: 'fulfilled',
        }),
      });

      console.log('[FW-SERVICE] Response status:', response.status);
      
      if (!response.ok) {
        const errorText = await response.text();
        console.error('[FW-SERVICE] Failed to update order. Status:', response.status);
        console.error('[FW-SERVICE] Error response:', errorText);
        throw new Error(`Failed to update Fourthwall order: ${response.status} - ${errorText}`);
      }

      console.log(`[FW-SERVICE] Successfully updated Fourthwall order ${fourthwallOrderId} with tracking ${trackingNumber}`);
    } catch (error) {
      console.error(`[FW-SERVICE] Error updating Fourthwall order ${fourthwallOrderId}:`, error);
      console.error('[FW-SERVICE] Error stack:', error instanceof Error ? error.stack : 'No stack');
      throw error;
    }
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
      const signature_hex = [...signature_array].map((b) => b.toString(16).padStart(2, '0')).join('');
      const expected_signature = `sha256=${signature_hex}`;
      
      console.log('[FW-SERVICE] Expected signature:', expected_signature);
      console.log('[FW-SERVICE] Provided signature:', signature);
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
}
