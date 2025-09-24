import {
  FulfillmentResult,
  KunakiOrderRequest,
  KunakiOrderResponse,
  KunakiStatusResponse,
  Order,
  OrderItem,
} from '../types/index.js';

export class KunakiService {
  private readonly baseUrl = 'https://kunaki.com/HTTPService.asp';

  constructor(
    private username: string,
    private password: string,
  ) {
    console.log('[KUNAKI] Initializing KunakiService');
    console.log('[KUNAKI] Username:', username ? 'provided' : 'missing');
    console.log('[KUNAKI] Password:', password ? 'provided' : 'missing');
  }

  async submitOrder(order: Order, orderItems: OrderItem[]): Promise<FulfillmentResult> {
    console.log('[KUNAKI] Submitting order:', order.id);
    console.log('[KUNAKI] Customer:', order.customer_name);
    console.log('[KUNAKI] Shipping to:', order.shipping_country);
    console.log('[KUNAKI] Number of items:', orderItems.length);
    
    try {
      for (const [index, item] of orderItems.entries()) {
        console.log(`[KUNAKI] Processing item ${index + 1}/${orderItems.length}:`, item.product_name);
        const mappedSku = this.mapProductToKunakiSku(item.fourthwall_product_id);
        console.log('[KUNAKI] Mapped product ID:', item.fourthwall_product_id, '->', mappedSku);
        
        const kunakiOrder: KunakiOrderRequest = {
          Product_Id: mappedSku,
          Quantity: item.quantity,
          Ship_Name: order.customer_name,
          Ship_Address: order.shipping_address_line1,
          Ship_Address_2: order.shipping_address_line2,
          Ship_City: order.shipping_city,
          Ship_State: order.shipping_state,
          Ship_Postal_Code: order.shipping_postal_code,
          Ship_Country: order.shipping_country,
          Order_Id: `${order.id}-${item.id}`,
        };
        console.log('[KUNAKI] Kunaki order ID:', kunakiOrder.Order_Id);

        const result = await this.submitSingleOrder(kunakiOrder);
        console.log('[KUNAKI] Submission result:', result.success ? 'success' : 'failed');
        
        if (!result.success) {
          console.error('[KUNAKI] Order submission failed:', result.error);
          return result;
        }

        console.log('[KUNAKI] Order submitted successfully, provider ID:', result.provider_order_id);
        return {
          success: true,
          provider_order_id: result.provider_order_id,
        };
      }

      console.error('[KUNAKI] No items to fulfill');
      return { success: false, error: 'No items to fulfill' };
    } catch (error) {
      console.error('[KUNAKI] Error submitting order:', error);
      console.error('[KUNAKI] Error stack:', error instanceof Error ? error.stack : 'No stack');
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  private async submitSingleOrder(orderData: KunakiOrderRequest): Promise<FulfillmentResult> {
    console.log('[KUNAKI] Submitting single order to Kunaki API');
    console.log('[KUNAKI] Order data:', JSON.stringify(orderData));
    
    const params = new URLSearchParams({
      userid: this.username,
      password: this.password,
      command: 'SubmitOrder',
      ...this.objectToKunakiParams(orderData),
    });
    console.log('[KUNAKI] API URL:', this.baseUrl);

    try {
      console.log('[KUNAKI] Making request to Kunaki API');
      const response = await fetch(this.baseUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: params.toString(),
      });
      
      console.log('[KUNAKI] Response status:', response.status);

      if (!response.ok) {
        console.error('[KUNAKI] HTTP error:', response.status, response.statusText);
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const responseText = await response.text();
      console.log('[KUNAKI] Order submit response text:', responseText);
      
      const result = this.parseKunakiResponse(responseText);
      console.log('[KUNAKI] Parsed submit response:', JSON.stringify(result));

      return result.Status === 'Success'
        ? {
            success: true,
            provider_order_id: result.Order_Id,
          }
        : {
            success: false,
            error: result.Error || 'Unknown Kunaki error',
          };
    } catch (error) {
      console.error('[KUNAKI] Error calling API:', error);
      console.error('[KUNAKI] Error stack:', error instanceof Error ? error.stack : 'No stack');
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Network error',
      };
    }
  }

  async checkOrderStatus(kunakiOrderId: string): Promise<KunakiStatusResponse> {
    console.log('[KUNAKI] Checking order status for:', kunakiOrderId);
    
    const params = new URLSearchParams({
      userid: this.username,
      password: this.password,
      command: 'OrderStatus',
      Order_Id: kunakiOrderId,
    });

    try {
      console.log('[KUNAKI] Making request to Kunaki API');
      const response = await fetch(this.baseUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: params.toString(),
      });
      
      console.log('[KUNAKI] Response status:', response.status);

      if (!response.ok) {
        console.error('[KUNAKI] HTTP error:', response.status, response.statusText);
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const responseText = await response.text();
      console.log('[KUNAKI] Status response text:', responseText);
      
      const statusResult = this.parseKunakiStatusResponse(responseText);
      console.log('[KUNAKI] Parsed status response:', JSON.stringify(statusResult));
      return statusResult;
    } catch (error) {
      console.error(`[KUNAKI] Error checking order status for ${kunakiOrderId}:`, error);
      console.error('[KUNAKI] Error stack:', error instanceof Error ? error.stack : 'No stack');
      return {
        Order_Id: kunakiOrderId,
        Status: 'Error',
        Error: error instanceof Error ? error.message : 'Network error',
      };
    }
  }

  private objectToKunakiParams(obj: Record<string, any>): Record<string, string> {
    const params: Record<string, string> = {};

    for (const [key, value] of Object.entries(obj)) {
      if (value !== undefined && value !== null) {
        params[key] = String(value);
      }
    }

    return params;
  }

  private parseKunakiResponse(responseText: string): KunakiOrderResponse {
    const lines = responseText.trim().split('\n');
    const result: Record<string, string> = {};

    for (const line of lines) {
      const [key, ...valueParts] = line.split('=');
      if (key && valueParts.length > 0) {
        result[key.trim()] = valueParts.join('=').trim();
      }
    }

    return {
      Order_Id: result.Order_Id || '',
      Status: result.Status || 'Error',
      Error: result.Error,
    };
  }

  private parseKunakiStatusResponse(responseText: string): KunakiStatusResponse {
    const lines = responseText.trim().split('\n');
    const result: Record<string, string> = {};

    for (const line of lines) {
      const [key, ...valueParts] = line.split('=');
      if (key && valueParts.length > 0) {
        result[key.trim()] = valueParts.join('=').trim();
      }
    }

    return {
      Order_Id: result.Order_Id || '',
      Status: result.Status || 'Error',
      Tracking_Number: result.Tracking_Number,
      Shipping_Date: result.Shipping_Date,
      Error: result.Error,
    };
  }

  private mapProductToKunakiSku(fourthwallProductId: string): string {
    console.log('[KUNAKI] Mapping product ID:', fourthwallProductId);
    const productMapping: Record<string, string> = {};

    const mappedSku = productMapping[fourthwallProductId] || fourthwallProductId;
    console.log('[KUNAKI] Mapped SKU:', mappedSku);
    return mappedSku;
  }

  canFulfillOrder(order: Order): boolean {
    const country = order.shipping_country.toUpperCase();
    console.log('[KUNAKI] Checking if can fulfill order to country:', country);
    
    const canFulfill = (
      country === 'US' ||
      country === 'USA' ||
      country === 'UNITED STATES'
    );
    
    console.log('[KUNAKI] Can fulfill:', canFulfill);
    return canFulfill;
  }

  mapKunakiStatusToFulfillmentStatus(kunakiStatus: string): string {
    console.log('[KUNAKI] Mapping status:', kunakiStatus);
    
    switch (kunakiStatus.toLowerCase()) {
      case 'success':
      case 'processing': {
        return 'processing';
      }
      case 'shipped': {
        return 'shipped';
      }
      case 'delivered': {
        return 'delivered';
      }
      case 'cancelled':
      case 'canceled': {
        return 'cancelled';
      }
      case 'error': {
        return 'failed';
      }
      default: {
        console.log('[KUNAKI] Unknown status, defaulting to processing');
        return 'processing';
      }
    }
  }
}
