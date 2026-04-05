import { FulfillmentRepository, OrderRepository } from '../repositories/index.js';
import {
  Env,
  FulfillmentProvider,
  FulfillmentResult,
  Order,
  OrderItem,
  ProductKeyEmailData,
  ProductKeyType,
} from '../types/index.js';
import { CDClickService, FourthwallService, KunakiService } from './index.js';

// Product key variant IDs for Immich retro CD
const PRODUCT_KEY_VARIANT_IDS = {
  CLIENT_KEY: '1a67c752-4293-4b60-b4c7-fc9ad060d9eb',
  SERVER_KEY: '9f1c1bce-dc6f-4471-96b3-e0b2f5a5b0fa',
  NO_KEY: '080a9d6d-3087-4ddd-8050-0d323d74f0eb',
} as const;

export class FulfillmentService {
  private kunakiService: KunakiService;
  private cdclickService: CDClickService;
  private fourthwallService: FourthwallService;

  constructor(
    private env: Env,
    private orderRepository: OrderRepository,
    private fulfillmentRepository: FulfillmentRepository,
  ) {
    console.log('[FULFILLMENT] Initializing FulfillmentService');
    console.log('[FULFILLMENT] Kunaki credentials:', env.KUNAKI_API_USERNAME ? 'provided' : 'missing');
    console.log('[FULFILLMENT] CDClick API key:', env.CDCLICK_API_KEY ? 'provided' : 'missing');
    this.kunakiService = new KunakiService(env.KUNAKI_API_USERNAME, env.KUNAKI_API_PASSWORD);
    this.cdclickService = new CDClickService(env.CDCLICK_API_KEY, env.ENVIRONMENT, env.CDCLICK_IDLE_MODE);
    this.fourthwallService = new FourthwallService(
      env.FOURTHWALL_USERNAME,
      env.FOURTHWALL_PASSWORD,
      orderRepository,
      env.FOURTHWALL_USER_USERNAME,
      env.FOURTHWALL_USER_PASSWORD,
    );
    console.log('[FULFILLMENT] All services initialized');
  }

  async processOrder(orderId: string): Promise<void> {
    console.log('[FULFILLMENT] Processing order:', orderId);

    try {
      console.log('[FULFILLMENT] Fetching order with items');
      const orderWithItems = await this.orderRepository.getOrderWithItems(orderId);
      if (!orderWithItems) {
        console.error('[FULFILLMENT] Order not found:', orderId);
        throw new Error(`Order not found: ${orderId}`);
      }

      const { order, items } = orderWithItems;
      console.log('[FULFILLMENT] Order status:', order.status);
      console.log('[FULFILLMENT] Number of items:', items.length);
      console.log('[FULFILLMENT] Shipping country:', order.shipping_country);

      // Check if this is a retry of a failed fulfillment
      let fulfillmentOrder = await this.fulfillmentRepository.getFulfillmentOrderByOrderId(orderId);

      if (fulfillmentOrder) {
        console.log('[FULFILLMENT] Found existing fulfillment order:', fulfillmentOrder.id);
        console.log('[FULFILLMENT] Fulfillment status:', fulfillmentOrder.status);

        // Only retry if the fulfillment failed
        if (fulfillmentOrder.status !== 'failed') {
          console.log(
            `[FULFILLMENT] Fulfillment order ${fulfillmentOrder.id} is not in 'failed' status (current: ${fulfillmentOrder.status}), skipping`,
          );
          return;
        }

        console.log('[FULFILLMENT] Retrying failed fulfillment order');
        console.log('[FULFILLMENT] Cloudflare Queues will handle retry limits and DLQ');

        // Reset status to pending for retry
        await this.fulfillmentRepository.updateFulfillmentOrderStatus(fulfillmentOrder.id, 'pending', {
          errorMessage: undefined,
        });
      } else {
        // New fulfillment - check order status
        if (order.status !== 'received') {
          console.log(
            `[FULFILLMENT] Order ${orderId} is not in 'received' status (current: ${order.status}), skipping`,
          );
          return;
        }

        console.log('[FULFILLMENT] Determining fulfillment provider');
        const provider = this.determineFulfillmentProvider(order);
        console.log('[FULFILLMENT] Selected provider:', provider);

        console.log('[FULFILLMENT] Updating order with provider:', provider);
        await this.orderRepository.updateOrderFulfillmentProvider(orderId, provider);

        console.log('[FULFILLMENT] Updating order status to processing');
        await this.orderRepository.updateOrderStatus(orderId, 'processing');

        console.log('[FULFILLMENT] Creating fulfillment order record');
        fulfillmentOrder = await this.fulfillmentRepository.createFulfillmentOrder({
          order_id: orderId,
          provider,
          status: 'pending',
          retry_count: 0,
          tracking_uploaded_to_fourthwall: 0,
        });

        // Queue product key emails early, independent of fulfillment success
        try {
          console.log('[FULFILLMENT] Checking for product key variants in order items');
          await this.processProductKeyVariants(order, items);
        } catch (error) {
          console.error('[FULFILLMENT] Error processing product key variants:', error);
          console.error('[FULFILLMENT] Error stack:', error instanceof Error ? error.stack : 'No stack');
          // Don't fail the fulfillment if product key processing fails
        }
      }

      console.log('[FULFILLMENT] Submitting order to provider:', fulfillmentOrder.provider);
      const result = await this.submitToProvider(fulfillmentOrder.provider, order, items);
      console.log('[FULFILLMENT] Submission result:', result.success ? 'success' : 'failed');
      if (result.provider_order_id) {
        console.log('[FULFILLMENT] Provider order ID:', result.provider_order_id);
      }

      if (result.success) {
        if (result.provider_order_id) {
          console.log('[FULFILLMENT] Updating fulfillment order status to submitted');
          await this.fulfillmentRepository.updateFulfillmentOrderStatus(fulfillmentOrder.id, 'submitted', {
            providerOrderId: result.provider_order_id,
            trackingNumber: result.tracking_number,
            trackingUrl: result.tracking_url,
            shippingCarrier: result.carrier,
          });
          console.log(`[FULFILLMENT] Successfully submitted order ${orderId} to ${fulfillmentOrder.provider}`);
          console.log(
            '[FULFILLMENT] Order will be marked as fulfilled when tracking is received via cron job or webhook',
          );
        } else {
          console.log('[FULFILLMENT] Order has no items with SKU mappings - marking as skipped');
          await this.fulfillmentRepository.updateFulfillmentOrderStatus(fulfillmentOrder.id, 'skipped', {
            errorMessage: 'No items have SKU mappings - fulfilled directly by Fourthwall',
          });
          await this.orderRepository.updateOrderStatus(orderId, 'skipped');
          console.log(`[FULFILLMENT] Order ${orderId} will be fulfilled directly by Fourthwall`);
        }
      } else {
        console.error('[FULFILLMENT] Submission failed, updating status to failed');
        await this.fulfillmentRepository.updateFulfillmentOrderStatus(fulfillmentOrder.id, 'failed', {
          errorMessage: result.error,
        });

        console.error(
          `[FULFILLMENT] Failed to submit order ${orderId} to ${fulfillmentOrder.provider}: ${result.error}`,
        );

        // Throw error to trigger Cloudflare's automatic retry mechanism
        throw new Error(`Failed to submit order ${orderId}: ${result.error}`);
      }
    } catch (error) {
      console.error(`[FULFILLMENT] Error processing order ${orderId}:`, error);
      console.error('[FULFILLMENT] Error stack:', error instanceof Error ? error.stack : 'No stack');

      // If it's an intentional failure (for retry/DLQ), re-throw it
      if (error instanceof Error && error.message.includes('Failed to submit order')) {
        throw error;
      }

      // For unexpected errors, revert status and still throw to trigger retry
      console.log('[FULFILLMENT] Reverting order status to received');
      await this.orderRepository.updateOrderStatus(orderId, 'received');
      throw error;
    }
  }

  private determineFulfillmentProvider(order: Order): FulfillmentProvider {
    console.log('[FULFILLMENT] Checking providers for country:', order.shipping_country);

    const kunakiCanFulfill = this.kunakiService.canFulfillOrder(order);
    console.log('[FULFILLMENT] Kunaki can fulfill:', kunakiCanFulfill);

    if (kunakiCanFulfill) {
      return 'kunaki';
    }

    const cdclickCanFulfill = this.cdclickService.canFulfillOrder(order);
    console.log('[FULFILLMENT] CDClick can fulfill:', cdclickCanFulfill);

    if (cdclickCanFulfill) {
      return 'cdclick-europe';
    }

    console.error('[FULFILLMENT] No provider available for country:', order.shipping_country);
    throw new Error(`No fulfillment provider available for country: ${order.shipping_country}`);
  }

  private async submitToProvider(
    provider: FulfillmentProvider,
    order: Order,
    items: OrderItem[],
  ): Promise<FulfillmentResult> {
    console.log('[FULFILLMENT] Submitting to provider:', provider);
    console.log('[FULFILLMENT] Order ID:', order.id);
    console.log('[FULFILLMENT] Item count:', items.length);

    switch (provider) {
      case 'kunaki': {
        console.log('[FULFILLMENT] Calling Kunaki submitOrder');
        return await this.kunakiService.submitOrder(order, items);
      }
      case 'cdclick-europe': {
        console.log('[FULFILLMENT] Calling CDClick submitOrder');
        return await this.cdclickService.submitOrder(order, items);
      }
      default: {
        console.error('[FULFILLMENT] Unknown provider:', provider);
        throw new Error(`Unknown provider: ${provider}`);
      }
    }
  }

  async processKunakiStatusUpdates(): Promise<void> {
    console.log('[FULFILLMENT] Processing Kunaki status updates');
    const pendingOrders = await this.fulfillmentRepository.getPendingKunakiOrders();
    console.log('[FULFILLMENT] Found', pendingOrders.length, 'pending Kunaki orders');

    for (const fulfillmentOrder of pendingOrders) {
      try {
        console.log('[FULFILLMENT] Checking status for fulfillment order:', fulfillmentOrder.id);

        if (!fulfillmentOrder.provider_order_id) {
          console.log(`[FULFILLMENT] Kunaki order ${fulfillmentOrder.id} has no provider order ID, skipping`);
          continue;
        }

        console.log('[FULFILLMENT] Checking Kunaki order:', fulfillmentOrder.provider_order_id);

        const statusResponse = await this.kunakiService.checkOrderStatus(fulfillmentOrder.provider_order_id);
        console.log('[FULFILLMENT] Kunaki status response:', JSON.stringify(statusResponse));

        if (statusResponse.Error) {
          console.error(
            `[FULFILLMENT] Error checking Kunaki order ${fulfillmentOrder.provider_order_id}: ${statusResponse.Error}`,
          );
          continue;
        }

        const newStatus = this.kunakiService.mapKunakiStatusToFulfillmentStatus(statusResponse.Status);
        console.log('[FULFILLMENT] Mapped status:', statusResponse.Status, '->', newStatus);
        console.log('[FULFILLMENT] Current status:', fulfillmentOrder.status);

        // Only mark as shipped if we have tracking information
        if (newStatus === 'shipped' && (!statusResponse.Tracking_Number || !statusResponse.Tracking_Type)) {
          console.log(
            '[FULFILLMENT] Order marked as shipped but no tracking number found, keeping status as processing',
          );
          // Don't update to shipped without tracking
          if (fulfillmentOrder.status !== 'processing') {
            await this.fulfillmentRepository.updateFulfillmentOrderStatus(fulfillmentOrder.id, 'processing', {
              shippedAt: statusResponse.Shipping_Date,
            });
            console.log(
              `[FULFILLMENT] Updated Kunaki order ${fulfillmentOrder.provider_order_id} status to processing (shipped without tracking)`,
            );
          }
        } else if (newStatus !== fulfillmentOrder.status) {
          console.log('[FULFILLMENT] Status changed, updating fulfillment order');
          await this.fulfillmentRepository.updateFulfillmentOrderStatus(fulfillmentOrder.id, newStatus as any, {
            trackingNumber: statusResponse.Tracking_Number,
            shippingCarrier: statusResponse.Tracking_Type,
            shippedAt: statusResponse.Shipping_Date,
          });

          if (newStatus === 'shipped' && statusResponse.Tracking_Number) {
            console.log(
              '[FULFILLMENT] Order shipped with tracking:',
              statusResponse.Tracking_Number,
              'Carrier: USPS (Kunaki always uses USPS)',
            );
            console.log('[FULFILLMENT] Tracking will be uploaded to Fourthwall via CSV in the next cron run');

            console.log('[FULFILLMENT] Updating order status to fulfilled');
            await this.orderRepository.updateOrderStatus(fulfillmentOrder.order_id, 'fulfilled');
          }

          console.log(
            `[FULFILLMENT] Updated Kunaki order ${fulfillmentOrder.provider_order_id} status to ${newStatus}`,
          );
        }
      } catch (error) {
        console.error(`[FULFILLMENT] Error processing Kunaki status update for order ${fulfillmentOrder.id}:`, error);
        console.error('[FULFILLMENT] Error stack:', error instanceof Error ? error.stack : 'No stack');
      }
    }
  }

  async processCDClickStatusUpdates(): Promise<void> {
    console.log('[FULFILLMENT] Processing CDClick status updates (max 50 orders)');
    const pendingOrders = await this.fulfillmentRepository.getPendingCDClickOrders();
    console.log('[FULFILLMENT] Found', pendingOrders.length, 'pending CDClick orders');

    for (const fulfillmentOrder of pendingOrders) {
      try {
        console.log('[FULFILLMENT] Checking status for fulfillment order:', fulfillmentOrder.id);

        if (!fulfillmentOrder.provider_order_id) {
          console.log(`[FULFILLMENT] CDClick order ${fulfillmentOrder.id} has no provider order ID, skipping`);
          continue;
        }

        console.log('[FULFILLMENT] Checking CDClick order:', fulfillmentOrder.provider_order_id);

        const statusResponse = await this.cdclickService.checkOrderStatus(fulfillmentOrder.provider_order_id);
        console.log('[FULFILLMENT] CDClick status response:', JSON.stringify(statusResponse));

        if (statusResponse.Error) {
          console.error(
            `[FULFILLMENT] Error checking CDClick order ${fulfillmentOrder.provider_order_id}: ${statusResponse.Error}`,
          );
          continue;
        }

        const newStatus = this.cdclickService.mapCDClickStatusToFulfillmentStatus(statusResponse.Status);
        console.log('[FULFILLMENT] Mapped status:', statusResponse.Status, '->', newStatus);
        console.log('[FULFILLMENT] Current status:', fulfillmentOrder.status);

        // Only mark as shipped if we have tracking information
        if (newStatus === 'shipped' && !statusResponse.Tracking_Number) {
          console.log(
            '[FULFILLMENT] Order marked as shipped but no tracking number found, keeping status as processing',
          );
          // Don't update to shipped without tracking
          if (fulfillmentOrder.status !== 'processing') {
            await this.fulfillmentRepository.updateFulfillmentOrderStatus(fulfillmentOrder.id, 'processing', {
              shippedAt: statusResponse.Shipping_Date,
            });
            console.log(
              `[FULFILLMENT] Updated CDClick order ${fulfillmentOrder.provider_order_id} status to processing (shipped without tracking)`,
            );
          }
        } else if (newStatus !== fulfillmentOrder.status) {
          console.log('[FULFILLMENT] Status changed, updating fulfillment order');
          await this.fulfillmentRepository.updateFulfillmentOrderStatus(fulfillmentOrder.id, newStatus as any, {
            trackingNumber: statusResponse.Tracking_Number,
            trackingUrl: statusResponse.Tracking_Url,
            shippingCarrier: statusResponse.Carrier,
            shippedAt: statusResponse.Shipping_Date,
          });

          if (newStatus === 'shipped' && statusResponse.Tracking_Number && statusResponse.Carrier) {
            console.log(
              '[FULFILLMENT] Order shipped with tracking:',
              statusResponse.Tracking_Number,
              'Carrier:',
              statusResponse.Carrier,
            );
            console.log('[FULFILLMENT] Tracking will be uploaded to Fourthwall via CSV in the next cron run');

            console.log('[FULFILLMENT] Updating order status to fulfilled');
            await this.orderRepository.updateOrderStatus(fulfillmentOrder.order_id, 'fulfilled');
          }

          console.log(
            `[FULFILLMENT] Updated CDClick order ${fulfillmentOrder.provider_order_id} status to ${newStatus}`,
          );
        }
      } catch (error) {
        console.error(`[FULFILLMENT] Error processing CDClick status update for order ${fulfillmentOrder.id}:`, error);
        console.error('[FULFILLMENT] Error stack:', error instanceof Error ? error.stack : 'No stack');
      }
    }
  }

  async processCDClickWebhook(webhook: any): Promise<void> {
    console.log('[FULFILLMENT] Processing CDClick webhook');
    console.log('[FULFILLMENT] Webhook data:', JSON.stringify(webhook));

    try {
      const processedWebhook = this.cdclickService.processWebhook(webhook);
      console.log('[FULFILLMENT] Processed webhook:', JSON.stringify(processedWebhook));

      console.log('[FULFILLMENT] Looking up fulfillment order by provider ID:', processedWebhook.orderId);
      const fulfillmentOrder = await this.fulfillmentRepository.getFulfillmentOrderByProviderOrderId(
        processedWebhook.orderId,
        'cdclick-europe',
      );

      if (!fulfillmentOrder) {
        console.log(`[FULFILLMENT] No fulfillment order found for CDClick order ${processedWebhook.orderId}`);
        return;
      }

      console.log('[FULFILLMENT] Updating fulfillment order status to:', processedWebhook.status);
      await this.fulfillmentRepository.updateFulfillmentOrderStatus(
        fulfillmentOrder.id,
        processedWebhook.status as any,
        {
          trackingNumber: processedWebhook.trackingNumber,
          trackingUrl: processedWebhook.trackingUrl,
          shippingCarrier: processedWebhook.carrier,
          shippedAt: processedWebhook.shippedAt,
        },
      );

      if (processedWebhook.status === 'shipped' && processedWebhook.trackingNumber) {
        console.log('[FULFILLMENT] Order shipped with tracking');
        console.log('[FULFILLMENT] Tracking will be uploaded to Fourthwall via CSV in the next cron run');

        console.log('[FULFILLMENT] Updating order status to fulfilled');
        await this.orderRepository.updateOrderStatus(fulfillmentOrder.order_id, 'fulfilled');
      }

      console.log(`[FULFILLMENT] Processed CDClick webhook for order ${processedWebhook.orderId}`);
    } catch (error) {
      console.error('[FULFILLMENT] Error processing CDClick webhook:', error);
      console.error('[FULFILLMENT] Error stack:', error instanceof Error ? error.stack : 'No stack');
      throw error;
    }
  }

  async retryFailedOrders(): Promise<void> {
    console.log('[FULFILLMENT] Retrying failed orders');
    const retryableOrders = await this.fulfillmentRepository.getRetryableFulfillmentOrders();
    console.log('[FULFILLMENT] Found', retryableOrders.length, 'retryable orders');

    for (const fulfillmentOrder of retryableOrders) {
      try {
        console.log('[FULFILLMENT] Retrying order:', fulfillmentOrder.order_id);
        console.log('[FULFILLMENT] Retry count:', fulfillmentOrder.retry_count);

        await this.fulfillmentRepository.incrementRetryCount(fulfillmentOrder.id);

        const orderWithItems = await this.orderRepository.getOrderWithItems(fulfillmentOrder.order_id);
        if (!orderWithItems) {
          console.error(`[FULFILLMENT] Order not found for retry: ${fulfillmentOrder.order_id}`);
          continue;
        }
        console.log('[FULFILLMENT] Order found, attempting retry');

        const { order, items } = orderWithItems;
        console.log('[FULFILLMENT] Retrying with provider:', fulfillmentOrder.provider);
        const result = await this.submitToProvider(fulfillmentOrder.provider, order, items);
        console.log('[FULFILLMENT] Retry result:', result.success ? 'success' : 'failed');

        if (result.success) {
          console.log('[FULFILLMENT] Retry successful, updating status to submitted');
          await this.fulfillmentRepository.updateFulfillmentOrderStatus(fulfillmentOrder.id, 'submitted', {
            providerOrderId: result.provider_order_id,
            trackingNumber: result.tracking_number,
            trackingUrl: result.tracking_url,
            shippingCarrier: result.carrier,
            errorMessage: undefined,
          });

          console.log(`[FULFILLMENT] Successfully retried order ${fulfillmentOrder.order_id}`);
        } else {
          console.error('[FULFILLMENT] Retry failed, updating status to failed');
          await this.fulfillmentRepository.updateFulfillmentOrderStatus(fulfillmentOrder.id, 'failed', {
            errorMessage: result.error,
          });

          console.error(`[FULFILLMENT] Retry failed for order ${fulfillmentOrder.order_id}: ${result.error}`);
        }
      } catch (error) {
        console.error(`[FULFILLMENT] Error retrying order ${fulfillmentOrder.order_id}:`, error);
        console.error('[FULFILLMENT] Error stack:', error instanceof Error ? error.stack : 'No stack');
      }
    }
  }

  private async processProductKeyVariants(order: Order, items: OrderItem[]): Promise<void> {
    console.log('[FULFILLMENT] Processing product key variants for order:', order.id);

    for (const item of items) {
      if (!item.fourthwall_variant_id) {
        console.log('[FULFILLMENT] Item has no variant ID, skipping:', item.product_name);
        continue;
      }

      let keyType: ProductKeyType | null = null;

      if (item.fourthwall_variant_id === PRODUCT_KEY_VARIANT_IDS.CLIENT_KEY) {
        keyType = 'client';
        console.log('[FULFILLMENT] Found client key variant in item:', item.product_name);
      } else if (item.fourthwall_variant_id === PRODUCT_KEY_VARIANT_IDS.SERVER_KEY) {
        keyType = 'server';
        console.log('[FULFILLMENT] Found server key variant in item:', item.product_name);
      } else {
        console.log('[FULFILLMENT] Item variant ID does not match product key variants:', item.fourthwall_variant_id);
        continue;
      }

      console.log(`[FULFILLMENT] Queueing ${keyType} key email for order ${order.id}`);

      // Queue email for each quantity of the item
      for (let i = 0; i < item.quantity; i++) {
        const emailData: ProductKeyEmailData = {
          orderId: order.id,
          customerEmail: order.customer_email,
          customerName: order.customer_name,
          keyType,
          keyValue: '', // Will be populated when the key is claimed
          activationKey: '', // Will be populated when the key is claimed
        };

        try {
          await this.env.EMAIL_QUEUE.send({
            type: 'product_key_email',
            data: emailData,
          });
          console.log(`[FULFILLMENT] Queued ${keyType} key email ${i + 1}/${item.quantity} for order ${order.id}`);
        } catch (error) {
          console.error(`[FULFILLMENT] Failed to queue ${keyType} key email for order ${order.id}:`, error);
          throw error;
        }
      }
    }

    console.log('[FULFILLMENT] Completed processing product key variants for order:', order.id);
  }

  private mapVariantToSku(variantId: string): string | null {
    const variantMapping: Record<string, string> = {
      [PRODUCT_KEY_VARIANT_IDS.CLIENT_KEY]: 'WVXN-R1W0500', // Client key SKU
      [PRODUCT_KEY_VARIANT_IDS.SERVER_KEY]: 'WVXN-PRV0400', // Server key SKU
      [PRODUCT_KEY_VARIANT_IDS.NO_KEY]: 'WVXN-AGQ0C00',
    };

    return variantMapping[variantId] || null;
  }

  private normalizeCarrierCode(carrier: string): string {
    // Map specific carrier codes to their normalized forms
    switch (carrier.toLowerCase()) {
      case 'http://usps.com': {
        return 'USPS';
      }
      default: {
        return carrier;
      }
    }
  }

  async uploadTrackingToFourthwall(): Promise<void> {
    console.log('[FULFILLMENT] Starting tracking upload to Fourthwall via CSV');

    try {
      // Get all orders with tracking that hasn't been uploaded yet
      const ordersToUpload = await this.fulfillmentRepository.getOrdersWithUnuploadedTracking();

      if (ordersToUpload.length === 0) {
        console.log('[FULFILLMENT] No orders with unuploaded tracking found');
        return;
      }

      console.log('[FULFILLMENT] Found', ordersToUpload.length, 'orders with tracking to upload');

      // Build tracking data array for CSV upload
      const trackingData: Array<{
        orderId: string;
        variantId: string;
        sku: string;
        quantity: number;
        trackingNumber: string;
        carrier: string;
        shippingAddress: string;
        shippingCountry: string;
      }> = [];

      const fulfillmentIdsToMark: string[] = [];

      for (const fulfillmentOrder of ordersToUpload) {
        try {
          console.log('[FULFILLMENT] Processing order:', fulfillmentOrder.order_id);

          // Get order details
          const orderWithItems = await this.orderRepository.getOrderWithItems(fulfillmentOrder.order_id);
          if (!orderWithItems) {
            console.error(`[FULFILLMENT] Order not found: ${fulfillmentOrder.order_id}`);
            continue;
          }

          const { order, items } = orderWithItems;

          // Add each item to the tracking data
          for (const item of items) {
            if (!item.fourthwall_variant_id) {
              console.log(`[FULFILLMENT] Skipping item without variant ID: ${item.product_name}`);
              continue;
            }

            // Map variant ID to SKU
            const sku = this.mapVariantToSku(item.fourthwall_variant_id);
            if (!sku) {
              console.log(`[FULFILLMENT] No SKU mapping for variant: ${item.fourthwall_variant_id}`);
              continue;
            }

            trackingData.push({
              orderId: order.fourthwall_order_id,
              variantId: item.fourthwall_variant_id,
              sku,
              quantity: item.quantity,
              trackingNumber: fulfillmentOrder.tracking_number!,
              carrier: this.normalizeCarrierCode(fulfillmentOrder.shipping_carrier!),
              shippingAddress: order.shipping_address_line1,
              shippingCountry: order.shipping_country,
            });
          }

          fulfillmentIdsToMark.push(fulfillmentOrder.id);
        } catch (error) {
          console.error(`[FULFILLMENT] Error processing order ${fulfillmentOrder.order_id} for CSV upload:`, error);
          // Continue with other orders even if one fails
        }
      }

      if (trackingData.length === 0) {
        console.log('[FULFILLMENT] No valid tracking data to upload');
        return;
      }

      console.log('[FULFILLMENT] Uploading tracking data for', trackingData.length, 'items');

      // Upload tracking CSV to Fourthwall
      const uploadResult = await this.fourthwallService.uploadTrackingCsv(trackingData);

      console.log('[FULFILLMENT] CSV upload complete');
      console.log('[FULFILLMENT] Fulfilled order IDs:', uploadResult.fulfilledOrderIds);

      // Parse errors to find already-uploaded orders
      // Fourthwall order IDs in errors are in different format than what we store,
      // so we can't match them. Instead, assume all orders not in errors were successful.
      const alreadyUploadedFourthwallOrderIds = new Set<string>();

      if (uploadResult.errors && uploadResult.errors.length > 0) {
        console.log('[FULFILLMENT] CSV upload had', uploadResult.errors.length, 'errors');
        console.log('[FULFILLMENT] Parsing errors for already-uploaded orders');

        for (const error of uploadResult.errors) {
          // Error format: "FulfillmentOrder(fbf1d1b1-90d7-466d-a6dd-a67c7d471fe8) variant(9f1c1bce-dc6f-4471-96b3-e0b2f5a5b0fa) 0 < 1"
          const match = error.match(/FulfillmentOrder\(([^)]+)\)/);
          if (match) {
            const fourthwallOrderId = match[1];
            alreadyUploadedFourthwallOrderIds.add(fourthwallOrderId);
            console.log('[FULFILLMENT] Found already-uploaded order in error:', fourthwallOrderId);
          } else {
            console.log('[FULFILLMENT] Could not parse error message:', error);
          }
        }
      }

      // Map our fulfillment orders to Fourthwall order IDs to determine which had errors
      const successfulFulfillmentIds: string[] = [];
      const alreadyUploadedFulfillmentIds: string[] = [];

      for (const fulfillmentOrder of ordersToUpload) {
        const orderWithItems = await this.orderRepository.getOrderWithItems(fulfillmentOrder.order_id);
        if (!orderWithItems) {
          continue;
        }

        const { order } = orderWithItems;
        const fourthwallOrderId = order.fourthwall_order_id;

        // If this order's ID is in the error list, mark as already uploaded (status 2)
        // Otherwise, assume it was successfully uploaded (status 1)
        if (alreadyUploadedFourthwallOrderIds.has(fourthwallOrderId)) {
          alreadyUploadedFulfillmentIds.push(fulfillmentOrder.id);
        } else {
          successfulFulfillmentIds.push(fulfillmentOrder.id);
        }
      }

      // Mark successfully uploaded orders with status 1
      if (successfulFulfillmentIds.length > 0) {
        await this.fulfillmentRepository.markTrackingAsUploaded(successfulFulfillmentIds, 1);
        console.log(
          '[FULFILLMENT] Marked',
          successfulFulfillmentIds.length,
          'orders as successfully uploaded (status 1)',
        );
      }

      // Mark already-uploaded orders with status 2
      if (alreadyUploadedFulfillmentIds.length > 0) {
        await this.fulfillmentRepository.markTrackingAsUploaded(alreadyUploadedFulfillmentIds, 2);
        console.log(
          '[FULFILLMENT] Marked',
          alreadyUploadedFulfillmentIds.length,
          'orders as already uploaded (status 2)',
        );
      }

      console.log('[FULFILLMENT] Tracking upload to Fourthwall completed successfully');
    } catch (error) {
      console.error('[FULFILLMENT] Error uploading tracking to Fourthwall:', error);
      console.error('[FULFILLMENT] Error stack:', error instanceof Error ? error.stack : 'No stack');
      throw error;
    }
  }
}
