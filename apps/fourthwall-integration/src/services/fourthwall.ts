import { OrderRepository } from '../repositories/index.js';
import { FourthwallOrderAttributes, FourthwallWebhook, Order } from '../types/index.js';

export class FourthwallService {
  constructor(
    private apiKey: string,
    private orderRepository: OrderRepository,
  ) {}

  async processWebhook(payload: FourthwallWebhook): Promise<void> {
    if (payload.type !== 'order.paid') {
      console.log(`Ignoring webhook type: ${payload.type}`);
      return;
    }

    const orderData = payload.data.attributes;

    const existingOrder = await this.orderRepository.getOrderByFourthwallId(orderData.id);
    if (existingOrder) {
      console.log(`Order ${orderData.id} already exists, skipping`);
      return;
    }

    const order = await this.createOrderFromWebhook(orderData);

    for (const lineItem of orderData.line_items) {
      await this.orderRepository.createOrderItem({
        order_id: order.id,
        fourthwall_product_id: lineItem.product_id,
        fourthwall_variant_id: lineItem.variant_id,
        product_name: lineItem.name,
        quantity: lineItem.quantity,
        unit_price_cents: lineItem.price.amount,
      });
    }

    console.log(`Created order ${order.id} from Fourthwall order ${orderData.id}`);
  }

  private async createOrderFromWebhook(orderData: FourthwallOrderAttributes): Promise<Order> {
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
    try {
      const response = await fetch(`https://api.fourthwall.com/v1/orders/${fourthwallOrderId}/fulfillment`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          tracking_number: trackingNumber,
          tracking_url: trackingUrl,
          carrier,
          status: 'fulfilled',
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Failed to update Fourthwall order: ${response.status} - ${errorText}`);
      }

      console.log(`Updated Fourthwall order ${fourthwallOrderId} with tracking ${trackingNumber}`);
    } catch (error) {
      console.error(`Error updating Fourthwall order ${fourthwallOrderId}:`, error);
      throw error;
    }
  }

  async validateWebhookSignature(payload: string, signature: string, secret: string): Promise<boolean> {
    try {
      const encoder = new TextEncoder();
      const keyData = encoder.encode(secret);
      const data = encoder.encode(payload);

      const key = await crypto.subtle.importKey('raw', keyData, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);

      const signature_buffer = await crypto.subtle.sign('HMAC', key, data);
      const signature_array = new Uint8Array(signature_buffer);
      const signature_hex = [...signature_array].map((b) => b.toString(16).padStart(2, '0')).join('');

      return `sha256=${signature_hex}` === signature;
    } catch (error) {
      console.error('Error validating webhook signature:', error);
      return false;
    }
  }

  async getOrder(orderId: string): Promise<any> {
    try {
      const response = await fetch(`https://api.fourthwall.com/v1/orders/${orderId}`, {
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
      });

      if (!response.ok) {
        throw new Error(`Failed to fetch order: ${response.status}`);
      }

      return await response.json();
    } catch (error) {
      console.error(`Error fetching order ${orderId}:`, error);
      throw error;
    }
  }
}
