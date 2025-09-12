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
  ) {}

  async submitOrder(order: Order, orderItems: OrderItem[]): Promise<FulfillmentResult> {
    try {
      for (const item of orderItems) {
        const kunakiOrder: KunakiOrderRequest = {
          Product_Id: this.mapProductToKunakiSku(item.fourthwall_product_id),
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

        const result = await this.submitSingleOrder(kunakiOrder);
        if (!result.success) {
          return result;
        }

        return {
          success: true,
          provider_order_id: result.provider_order_id,
        };
      }

      return { success: false, error: 'No items to fulfill' };
    } catch (error) {
      console.error('Error submitting Kunaki order:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  private async submitSingleOrder(orderData: KunakiOrderRequest): Promise<FulfillmentResult> {
    const params = new URLSearchParams({
      userid: this.username,
      password: this.password,
      command: 'SubmitOrder',
      ...this.objectToKunakiParams(orderData),
    });

    try {
      const response = await fetch(this.baseUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: params.toString(),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const responseText = await response.text();
      const result = this.parseKunakiResponse(responseText);

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
      console.error('Error calling Kunaki API:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Network error',
      };
    }
  }

  async checkOrderStatus(kunakiOrderId: string): Promise<KunakiStatusResponse> {
    const params = new URLSearchParams({
      userid: this.username,
      password: this.password,
      command: 'OrderStatus',
      Order_Id: kunakiOrderId,
    });

    try {
      const response = await fetch(this.baseUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: params.toString(),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const responseText = await response.text();
      return this.parseKunakiStatusResponse(responseText);
    } catch (error) {
      console.error(`Error checking Kunaki order status for ${kunakiOrderId}:`, error);
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
    const productMapping: Record<string, string> = {};

    return productMapping[fourthwallProductId] || fourthwallProductId;
  }

  canFulfillOrder(order: Order): boolean {
    return (
      order.shipping_country.toUpperCase() === 'US' ||
      order.shipping_country.toUpperCase() === 'USA' ||
      order.shipping_country.toUpperCase() === 'UNITED STATES'
    );
  }

  mapKunakiStatusToFulfillmentStatus(kunakiStatus: string): string {
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
        return 'processing';
      }
    }
  }
}
