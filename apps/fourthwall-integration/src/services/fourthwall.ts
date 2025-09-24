import { OrderRepository } from '../repositories/index.js';
import { FourthwallOrderAttributes, FourthwallOrderData, FourthwallWebhook, Order } from '../types/index.js';

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
          fourthwall_variant_id: offer.variant?.id || null,
          product_name: offer.variant?.name || offer.name,
          quantity: quantity,
          unit_price_cents: Math.round(unitPrice * 100), // Convert to cents
        });
      }
    }

    console.log(`[FW-SERVICE] Successfully created order ${order.id} from Fourthwall order ${orderData.id} with ${orderData.offers?.length || 0} items`);
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
      customer_name: orderData.shipping?.address?.name || orderData.billing?.address?.name || orderData.username || 'Unknown',
      shipping_address_line1: orderData.shipping?.address?.address1 || '',
      shipping_address_line2: orderData.shipping?.address?.address2 || null, // Ensure null not undefined
      shipping_city: orderData.shipping?.address?.city || '',
      shipping_state: orderData.shipping?.address?.state || null, // Ensure null not undefined
      shipping_postal_code: orderData.shipping?.address?.zip || '',
      shipping_country: orderData.shipping?.address?.country || '',
      order_total_cents: Math.round((orderData.amounts?.total?.value || 0) * 100), // Convert to cents
      order_currency: orderData.amounts?.total?.currency || 'USD',
      status: 'received',
      fulfillment_provider: null, // Explicitly set to null initially
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
      
      // Fourthwall uses base64 encoding, not hex
      const expected_signature = btoa(String.fromCharCode(...signature_array));
      
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
}
