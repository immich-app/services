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

  constructor(private apiKey: string) {
    console.log('[CDCLICK] Initializing CDClickService');
    console.log('[CDCLICK] API key:', apiKey ? 'provided' : 'missing');
  }

  async submitOrder(order: Order, orderItems: OrderItem[]): Promise<FulfillmentResult> {
    console.log('[CDCLICK] Submitting order:', order.id);
    console.log('[CDCLICK] Customer:', order.customer_name);
    console.log('[CDCLICK] Shipping to:', order.shipping_country);
    console.log('[CDCLICK] Number of items:', orderItems.length);
    
    try {
      // Filter items that have SKU mappings
      const fulfillableItems: { sku: string; quantity: number }[] = [];
      const skippedItems: OrderItem[] = [];
      
      for (const item of orderItems) {
        const mappedSku = this.mapProductToCDClickSku(item.fourthwall_product_id);
        if (mappedSku) {
          fulfillableItems.push({
            sku: mappedSku,
            quantity: item.quantity,
          });
        } else {
          skippedItems.push(item);
        }
      }
      
      console.log('[CDCLICK] Fulfillable items:', fulfillableItems.length);
      console.log('[CDCLICK] Skipped items (no SKU mapping):', skippedItems.length);
      
      if (skippedItems.length > 0) {
        console.log('[CDCLICK] Skipped items details:');
        for (const item of skippedItems) {
          console.log(`[CDCLICK]   - ${item.product_name} (ID: ${item.fourthwall_product_id})`);
        }
      }
      
      if (fulfillableItems.length === 0) {
        console.log('[CDCLICK] No items have SKU mappings for CDClick fulfillment');
        return { success: false, error: 'No items have SKU mappings for CDClick fulfillment' };
      }
      
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
        items: fulfillableItems,
      };

      console.log('[CDCLICK] Request payload:', JSON.stringify(cdclickOrder));
      const url = `${this.baseUrl}/orders`;
      console.log('[CDCLICK] Making POST request to:', url);
      
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(cdclickOrder),
      });
      
      console.log('[CDCLICK] Response status:', response.status);

      if (!response.ok) {
        const errorText = await response.text();
        console.error('[CDCLICK] API error:', response.status, errorText);
        throw new Error(`CDClick API error: ${response.status} - ${errorText}`);
      }

      const result: CDClickOrderResponse = await response.json();
      console.log('[CDCLICK] Response data:', JSON.stringify(result));

      console.log('[CDCLICK] Order submitted successfully');
      console.log('[CDCLICK] Provider order ID:', result.id);
      console.log('[CDCLICK] Tracking:', result.tracking?.number || 'not yet available');
      
      return {
        success: true,
        provider_order_id: result.id,
        tracking_number: result.tracking?.number,
        tracking_url: result.tracking?.url,
        carrier: result.tracking?.carrier,
      };
    } catch (error) {
      console.error('[CDCLICK] Error submitting order:', error);
      console.error('[CDCLICK] Error stack:', error instanceof Error ? error.stack : 'No stack');
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  async getOrderStatus(cdclickOrderId: string): Promise<CDClickOrderResponse | null> {
    console.log('[CDCLICK] Getting order status for:', cdclickOrderId);
    
    try {
      const url = `${this.baseUrl}/orders/${cdclickOrderId}`;
      console.log('[CDCLICK] Making GET request to:', url);
      
      const response = await fetch(url, {
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
      });
      
      console.log('[CDCLICK] Response status:', response.status);

      if (!response.ok) {
        if (response.status === 404) {
          console.log('[CDCLICK] Order not found');
          return null;
        }
        console.error('[CDCLICK] API error:', response.status);
        throw new Error(`CDClick API error: ${response.status}`);
      }

      const data = await response.json();
      console.log('[CDCLICK] Order status data:', JSON.stringify(data));
      return data as CDClickOrderResponse;
    } catch (error) {
      console.error(`[CDCLICK] Error fetching order ${cdclickOrderId}:`, error);
      console.error('[CDCLICK] Error stack:', error instanceof Error ? error.stack : 'No stack');
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
    console.log('[CDCLICK] Processing webhook payload');
    console.log('[CDCLICK] Order ID:', payload.order_id);
    console.log('[CDCLICK] Event type:', payload.event_type);
    console.log('[CDCLICK] Status:', payload.status);
    
    const mappedStatus = this.mapCDClickStatusToFulfillmentStatus(payload.status);
    console.log('[CDCLICK] Mapped status:', payload.status, '->', mappedStatus);
    
    return {
      orderId: payload.order_id,
      status: mappedStatus,
      trackingNumber: payload.tracking_number,
      trackingUrl: payload.tracking_url,
      carrier: payload.carrier,
      shippedAt: payload.shipped_at,
    };
  }

  async validateWebhookSignature(payload: string, signature: string, secret: string): Promise<boolean> {
    console.log('[CDCLICK] Validating webhook signature');
    console.log('[CDCLICK] Signature provided:', signature ? 'yes' : 'no');
    console.log('[CDCLICK] Secret provided:', secret ? 'yes' : 'no');
    console.log('[CDCLICK] Payload length:', payload.length);
    
    try {
      const encoder = new TextEncoder();
      const keyData = encoder.encode(secret);
      const data = encoder.encode(payload);

      const key = await crypto.subtle.importKey('raw', keyData, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);

      const signature_buffer = await crypto.subtle.sign('HMAC', key, data);
      const signature_array = new Uint8Array(signature_buffer);
      const signature_hex = [...signature_array].map((b) => b.toString(16).padStart(2, '0')).join('');

      const isValid = signature_hex === signature;
      console.log('[CDCLICK] Expected signature:', signature_hex);
      console.log('[CDCLICK] Provided signature:', signature);
      console.log('[CDCLICK] Signature validation result:', isValid);
      
      return isValid;
    } catch (error) {
      console.error('[CDCLICK] Error validating webhook signature:', error);
      console.error('[CDCLICK] Error stack:', error instanceof Error ? error.stack : 'No stack');
      return false;
    }
  }

  private mapProductToCDClickSku(fourthwallProductId: string): string | null {
    console.log('[CDCLICK] Mapping product ID:', fourthwallProductId);
    const productMapping: Record<string, string> = {};

    const mappedSku = productMapping[fourthwallProductId];
    if (!mappedSku) {
      console.log('[CDCLICK] No SKU mapping found for product:', fourthwallProductId);
      return null;
    }
    console.log('[CDCLICK] Mapped SKU:', mappedSku);
    return mappedSku;
  }

  canFulfillOrder(order: Order): boolean {
    const country = order.shipping_country.toUpperCase();
    console.log('[CDCLICK] Checking if can fulfill order to country:', country);
    
    const excludedCountries = ['US', 'USA', 'UNITED STATES'];
    const canFulfill = !excludedCountries.includes(country);
    
    console.log('[CDCLICK] Can fulfill:', canFulfill);
    return canFulfill;
  }

  mapCDClickStatusToFulfillmentStatus(cdclickStatus: string): string {
    console.log('[CDCLICK] Mapping status:', cdclickStatus);
    
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
        console.log('[CDCLICK] Unknown status, defaulting to processing');
        return 'processing';
      }
    }
  }

  async cancelOrder(cdclickOrderId: string): Promise<boolean> {
    console.log('[CDCLICK] Cancelling order:', cdclickOrderId);
    
    try {
      const url = `${this.baseUrl}/orders/${cdclickOrderId}/cancel`;
      console.log('[CDCLICK] Making POST request to:', url);
      
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
      });
      
      console.log('[CDCLICK] Cancel response status:', response.status);
      const success = response.ok;
      console.log('[CDCLICK] Cancel result:', success ? 'success' : 'failed');
      
      return success;
    } catch (error) {
      console.error(`[CDCLICK] Error cancelling order ${cdclickOrderId}:`, error);
      console.error('[CDCLICK] Error stack:', error instanceof Error ? error.stack : 'No stack');
      return false;
    }
  }

  async getAvailableProducts(): Promise<any[]> {
    console.log('[CDCLICK] Getting available products');
    
    try {
      const url = `${this.baseUrl}/products`;
      console.log('[CDCLICK] Making GET request to:', url);
      
      const response = await fetch(url, {
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
      });
      
      console.log('[CDCLICK] Response status:', response.status);

      if (!response.ok) {
        console.error('[CDCLICK] API error:', response.status);
        throw new Error(`CDClick API error: ${response.status}`);
      }

      const products = await response.json();
      console.log('[CDCLICK] Found', Array.isArray(products) ? products.length : 0, 'products');
      return products as any[];
    } catch (error) {
      console.error('[CDCLICK] Error fetching products:', error);
      console.error('[CDCLICK] Error stack:', error instanceof Error ? error.stack : 'No stack');
      throw error;
    }
  }
}
