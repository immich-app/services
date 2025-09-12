import {
  CDClickOrderRequest,
  CDClickOrderResponse,
  CDClickWebhook,
  FulfillmentResult,
  Order,
  OrderItem,
} from '../types/index.js';

export class CDClickService {
  private readonly baseUrl = 'https://wall.cdclick-europe.com/API';

  constructor(private apiKey: string) {}

  async submitOrder(order: Order, orderItems: OrderItem[]): Promise<FulfillmentResult> {
    try {
      const cdclickOrder: CDClickOrderRequest = {
        reference: order.id,
        recipient: {
          name: order.customer_name,
          address: {
            street: order.shipping_address_line1,
            street2: order.shipping_address_line2,
            city: order.shipping_city,
            state: order.shipping_state,
            zip: order.shipping_postal_code,
            country: order.shipping_country,
          },
        },
        items: orderItems.map((item) => ({
          sku: this.mapProductToCDClickSku(item.fourthwall_product_id),
          quantity: item.quantity,
        })),
      };

      const response = await fetch(`${this.baseUrl}/orders`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(cdclickOrder),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`CDClick API error: ${response.status} - ${errorText}`);
      }

      const result: CDClickOrderResponse = await response.json();

      return {
        success: true,
        provider_order_id: result.id,
        tracking_number: result.tracking?.number,
        tracking_url: result.tracking?.url,
        carrier: result.tracking?.carrier,
      };
    } catch (error) {
      console.error('Error submitting CDClick order:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  async getOrderStatus(cdclickOrderId: string): Promise<CDClickOrderResponse | null> {
    try {
      const response = await fetch(`${this.baseUrl}/orders/${cdclickOrderId}`, {
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
      });

      if (!response.ok) {
        if (response.status === 404) {
          return null;
        }
        throw new Error(`CDClick API error: ${response.status}`);
      }

      return await response.json();
    } catch (error) {
      console.error(`Error fetching CDClick order ${cdclickOrderId}:`, error);
      throw error;
    }
  }

  processWebhook(payload: CDClickWebhook): {
    orderId: string;
    status: string;
    trackingNumber?: string;
    trackingUrl?: string;
    carrier?: string;
    shippedAt?: string;
  } {
    return {
      orderId: payload.order_id,
      status: this.mapCDClickStatusToFulfillmentStatus(payload.status),
      trackingNumber: payload.tracking_number,
      trackingUrl: payload.tracking_url,
      carrier: payload.carrier,
      shippedAt: payload.shipped_at,
    };
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

      return signature_hex === signature;
    } catch (error) {
      console.error('Error validating CDClick webhook signature:', error);
      return false;
    }
  }

  private mapProductToCDClickSku(fourthwallProductId: string): string {
    const productMapping: Record<string, string> = {};

    return productMapping[fourthwallProductId] || fourthwallProductId;
  }

  canFulfillOrder(order: Order): boolean {
    const excludedCountries = ['US', 'USA', 'UNITED STATES'];
    return !excludedCountries.includes(order.shipping_country.toUpperCase());
  }

  mapCDClickStatusToFulfillmentStatus(cdclickStatus: string): string {
    switch (cdclickStatus.toLowerCase()) {
      case 'pending': {
        return 'pending';
      }
      case 'accepted':
      case 'processing': {
        return 'processing';
      }
      case 'shipped':
      case 'dispatched': {
        return 'shipped';
      }
      case 'delivered': {
        return 'delivered';
      }
      case 'cancelled':
      case 'canceled': {
        return 'cancelled';
      }
      case 'failed':
      case 'rejected': {
        return 'failed';
      }
      default: {
        return 'processing';
      }
    }
  }

  async cancelOrder(cdclickOrderId: string): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/orders/${cdclickOrderId}/cancel`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
      });

      return response.ok;
    } catch (error) {
      console.error(`Error cancelling CDClick order ${cdclickOrderId}:`, error);
      return false;
    }
  }

  async getAvailableProducts(): Promise<any[]> {
    try {
      const response = await fetch(`${this.baseUrl}/products`, {
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
      });

      if (!response.ok) {
        throw new Error(`CDClick API error: ${response.status}`);
      }

      return await response.json();
    } catch (error) {
      console.error('Error fetching CDClick products:', error);
      throw error;
    }
  }
}
