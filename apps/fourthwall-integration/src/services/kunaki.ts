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
      // Filter items that have SKU mappings
      const fulfillableItems: OrderItem[] = [];
      const skippedItems: OrderItem[] = [];

      for (const item of orderItems) {
        const mappedSku = this.mapProductToKunakiSku(item.fourthwall_product_id);
        if (mappedSku) {
          fulfillableItems.push(item);
        } else {
          skippedItems.push(item);
        }
      }

      console.log('[KUNAKI] Fulfillable items:', fulfillableItems.length);
      console.log('[KUNAKI] Skipped items (no SKU mapping):', skippedItems.length);

      if (skippedItems.length > 0) {
        console.log('[KUNAKI] Skipped items details:');
        for (const item of skippedItems) {
          console.log(`[KUNAKI]   - ${item.product_name} (ID: ${item.fourthwall_product_id})`);
        }
      }

      if (fulfillableItems.length === 0) {
        console.log(
          '[KUNAKI] No items have SKU mappings for Kunaki fulfillment - order will be fulfilled directly by Fourthwall',
        );
        return { success: true, provider_order_id: undefined };
      }

      // Process only items with SKU mappings
      for (const [index, item] of fulfillableItems.entries()) {
        console.log(`[KUNAKI] Processing item ${index + 1}/${fulfillableItems.length}:`, item.product_name);
        const mappedSku = this.mapProductToKunakiSku(item.fourthwall_product_id);
        console.log('[KUNAKI] Using SKU:', mappedSku);

        const kunakiOrder: KunakiOrderRequest = {
          Product_Id: mappedSku!,
          Quantity: item.quantity,
          Ship_Name: order.customer_name,
          Ship_Address: order.shipping_address_line1,
          Ship_City: order.shipping_city,
          Ship_Postal_Code: order.shipping_postal_code,
          Ship_Country: order.shipping_country,
          Order_Id: `${order.id}-${item.id}`,
        };

        // Only add optional fields if they have values
        if (order.shipping_address_line2) {
          kunakiOrder.Ship_Address_2 = order.shipping_address_line2;
        }
        if (order.shipping_state) {
          kunakiOrder.Ship_State = order.shipping_state;
        }
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

    // Map our field names to Kunaki's expected parameter names
    const kunakiParams: Record<string, string> = {
      RequestType: 'Order',
      UserId: this.username,
      Password: this.password,
      Mode: 'Live', // Use 'TEST' for testing
      Name: orderData.Ship_Name,
      Address1: orderData.Ship_Address,
      City: orderData.Ship_City,
      PostalCode: orderData.Ship_Postal_Code,
      Country: this.mapCountryForKunaki(orderData.Ship_Country),
      ShippingDescription: 'USPS First Class Mail', // Default shipping method
      ProductId: orderData.Product_Id,
      Quantity: String(orderData.Quantity),
      OrderId: orderData.Order_Id || '',
    };

    // Add optional fields if present
    if (orderData.Ship_Address_2) {
      kunakiParams.Address2 = orderData.Ship_Address_2;
    }
    if (orderData.Ship_State) {
      kunakiParams.State_Province = orderData.Ship_State;
    }

    const params = new URLSearchParams(kunakiParams);
    console.log('[KUNAKI] API URL:', this.baseUrl);
    console.log(
      '[KUNAKI] Request params (excluding credentials):',
      JSON.stringify({
        ...kunakiParams,
        UserId: '***',
        Password: '***',
      }),
    );

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
      console.log('[KUNAKI] Response length:', responseText.length);

      // Log the raw response for debugging
      if (responseText.length === 0) {
        console.error('[KUNAKI] Empty response from Kunaki API');
      }

      const result = this.parseKunakiResponse(responseText);
      console.log('[KUNAKI] Parsed submit response:', JSON.stringify(result));

      return result.Status === 'Success'
        ? {
            success: true,
            provider_order_id: result.Order_Id,
          }
        : {
            success: false,
            error: result.Error || (responseText.length === 0 ? 'Empty response from Kunaki' : 'Unknown Kunaki error'),
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
      RequestType: 'OrderStatus',
      UserId: this.username,
      Password: this.password,
      OrderId: kunakiOrderId,
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

  private parseKunakiResponse(responseText: string): KunakiOrderResponse {
    // Handle empty response
    if (!responseText || responseText.trim().length === 0) {
      console.log('[KUNAKI] Empty response - likely authentication or parameter error');
      return {
        Order_Id: '',
        Status: 'Error',
        Error: 'Empty response - check authentication and parameters',
      };
    }

    // Kunaki returns XML format
    // Example: <Response><ErrorCode>0</ErrorCode><ErrorText>success</ErrorText><OrderId>3345059</OrderId></Response>
    console.log('[KUNAKI] Parsing XML response');

    // Simple XML parsing for the specific fields we need
    const errorCode = this.extractXMLValue(responseText, 'ErrorCode');
    const errorText = this.extractXMLValue(responseText, 'ErrorText');
    const orderId = this.extractXMLValue(responseText, 'OrderId');

    console.log('[KUNAKI] Parsed - ErrorCode:', errorCode, 'ErrorText:', errorText, 'OrderId:', orderId);

    // ErrorCode 0 means success
    return errorCode === '0' ? {
        Order_Id: orderId || '',
        Status: 'Success',
        Error: undefined,
      } : {
        Order_Id: '',
        Status: 'Error',
        Error: errorText || `Error code: ${errorCode}`,
      };
  }

  private extractXMLValue(xml: string, tagName: string): string | undefined {
    const regex = new RegExp(`<${tagName}>([^<]*)</${tagName}>`, 'i');
    const match = xml.match(regex);
    return match ? match[1] : undefined;
  }

  private parseKunakiStatusResponse(responseText: string): KunakiStatusResponse {
    // Kunaki returns XML format for status check too
    console.log('[KUNAKI] Parsing status XML response');

    const errorCode = this.extractXMLValue(responseText, 'ErrorCode');
    const errorText = this.extractXMLValue(responseText, 'ErrorText');
    const orderId = this.extractXMLValue(responseText, 'OrderId');
    const orderStatus = this.extractXMLValue(responseText, 'OrderStatus');
    const trackingNumber = this.extractXMLValue(responseText, 'TrackingNumber');
    const _trackingType = this.extractXMLValue(responseText, 'TrackingType');

    console.log(
      '[KUNAKI] Status response - ErrorCode:',
      errorCode,
      'OrderStatus:',
      orderStatus,
      'Tracking:',
      trackingNumber,
    );

    return errorCode === '0' ? {
        Order_Id: orderId || '',
        Status: orderStatus || 'Processing',
        Tracking_Number: trackingNumber,
        Shipping_Date: undefined,
        Error: undefined,
      } : {
        Order_Id: orderId || '',
        Status: 'Error',
        Tracking_Number: undefined,
        Shipping_Date: undefined,
        Error: errorText || `Error code: ${errorCode}`,
      };
  }

  private mapCountryForKunaki(countryCode: string): string {
    // Map country codes to Kunaki's expected country names
    const countryMap: Record<string, string> = {
      US: 'United States',
      USA: 'United States',
      'UNITED STATES': 'United States',
      CA: 'Canada',
      CANADA: 'Canada',
      GB: 'United Kingdom',
      UK: 'United Kingdom',
      'UNITED KINGDOM': 'United Kingdom',
      // Add more countries as needed
    };

    const mapped = countryMap[countryCode.toUpperCase()];
    if (mapped) {
      console.log('[KUNAKI] Mapped country:', countryCode, '->', mapped);
      return mapped;
    }

    console.log('[KUNAKI] Using country code as-is:', countryCode);
    return countryCode;
  }

  private mapProductToKunakiSku(fourthwallProductId: string): string | null {
    console.log('[KUNAKI] Mapping product ID:', fourthwallProductId);
    const productMapping: Record<string, string> = {
      'b2c201d3-8104-4b2a-b2c9-1f6b335b650a': 'PX00ZYCKTY', //Fourthwall test webhook product
      'a53316f3-3b7e-493c-b585-e0d3d23d44b9': 'PX00ZYCKTY', //Immich Retro
    };

    const mappedSku = productMapping[fourthwallProductId];
    if (!mappedSku) {
      console.log('[KUNAKI] No SKU mapping found for product:', fourthwallProductId);
      return null;
    }
    console.log('[KUNAKI] Mapped SKU:', mappedSku);
    return mappedSku;
  }

  canFulfillOrder(order: Order): boolean {
    const country = order.shipping_country.toUpperCase();
    console.log('[KUNAKI] Checking if can fulfill order to country:', country);

    const canFulfill = country === 'US' || country === 'USA' || country === 'UNITED STATES';

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
