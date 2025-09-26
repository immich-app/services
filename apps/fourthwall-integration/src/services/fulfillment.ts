import { FulfillmentRepository, OrderRepository } from '../repositories/index.js';
import { Env, FulfillmentProvider, FulfillmentResult, Order, OrderItem } from '../types/index.js';
import { CDClickService, FourthwallService, KunakiService } from './index.js';

export class FulfillmentService {
  private kunakiService: KunakiService;
  private cdclickService: CDClickService;
  private fourthwallService: FourthwallService;
  private readonly MAX_RETRY_ATTEMPTS = 3;

  constructor(
    private env: Env,
    private orderRepository: OrderRepository,
    private fulfillmentRepository: FulfillmentRepository,
  ) {
    console.log('[FULFILLMENT] Initializing FulfillmentService');
    console.log('[FULFILLMENT] Kunaki credentials:', env.KUNAKI_API_USERNAME ? 'provided' : 'missing');
    console.log('[FULFILLMENT] CDClick API key:', env.CDCLICK_API_KEY ? 'provided' : 'missing');
    this.kunakiService = new KunakiService(env.KUNAKI_API_USERNAME, env.KUNAKI_API_PASSWORD);
    this.cdclickService = new CDClickService(env.CDCLICK_API_KEY, env.ENVIRONMENT);
    this.fourthwallService = new FourthwallService(env.FOURTHWALL_USERNAME, env.FOURTHWALL_PASSWORD, orderRepository);
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
          console.log(`[FULFILLMENT] Fulfillment order ${fulfillmentOrder.id} is not in 'failed' status (current: ${fulfillmentOrder.status}), skipping`);
          return;
        }

        console.log('[FULFILLMENT] Retrying failed fulfillment order');
        console.log('[FULFILLMENT] Current retry count:', fulfillmentOrder.retry_count);

        // Check if we've exceeded max retries
        if (fulfillmentOrder.retry_count >= this.MAX_RETRY_ATTEMPTS) {
          console.error(`[FULFILLMENT] Max retry attempts (${this.MAX_RETRY_ATTEMPTS}) reached for order ${orderId}`);
          console.log('[FULFILLMENT] Order will be sent to DLQ');
          await this.fulfillmentRepository.updateFulfillmentOrderStatus(fulfillmentOrder.id, 'failed', {
            errorMessage: `Max retry attempts (${this.MAX_RETRY_ATTEMPTS}) exceeded`,
          });
          // Throw error to let Cloudflare handle DLQ
          throw new Error(`Max retry attempts exceeded for order ${orderId}`);
        }

        // Reset status to pending for retry and increment retry count
        await this.fulfillmentRepository.updateFulfillmentOrderStatus(fulfillmentOrder.id, 'pending', {
          errorMessage: undefined,
        });
        await this.fulfillmentRepository.incrementRetryCount(fulfillmentOrder.id);
      } else {
        // New fulfillment - check order status
        if (order.status !== 'received') {
          console.log(`[FULFILLMENT] Order ${orderId} is not in 'received' status (current: ${order.status}), skipping`);
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
        });
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

          // Notify Fourthwall that the order is in production
          try {
            console.log('[FULFILLMENT] Notifying Fourthwall that order is in production');
            // Use "In Production" as the shipping company until we have real tracking
            await this.fourthwallService.createFulfillment(
              order.fourthwall_order_id,
              items,
              'PENDING',
              'In Production'
            );
            console.log('[FULFILLMENT] Successfully notified Fourthwall');
          } catch (error) {
            console.error('[FULFILLMENT] Error notifying Fourthwall about order in production:', error);
            console.error('[FULFILLMENT] Error stack:', error instanceof Error ? error.stack : 'No stack');
            // Don't fail the fulfillment if Fourthwall notification fails
          }
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

        console.error(`[FULFILLMENT] Failed to submit order ${orderId} to ${fulfillmentOrder.provider}: ${result.error}`);

        // Throw error to trigger Cloudflare's automatic retry mechanism
        throw new Error(`Failed to submit order ${orderId}: ${result.error}`);
      }
    } catch (error) {
      console.error(`[FULFILLMENT] Error processing order ${orderId}:`, error);
      console.error('[FULFILLMENT] Error stack:', error instanceof Error ? error.stack : 'No stack');

      // If it's an intentional failure (for retry/DLQ), re-throw it
      if (error instanceof Error && (
        error.message.includes('Failed to submit order') ||
        error.message.includes('Max retry attempts exceeded')
      )) {
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
          console.error(`[FULFILLMENT] Error checking Kunaki order ${fulfillmentOrder.provider_order_id}: ${statusResponse.Error}`);
          continue;
        }

        const newStatus = this.kunakiService.mapKunakiStatusToFulfillmentStatus(statusResponse.Status);
        console.log('[FULFILLMENT] Mapped status:', statusResponse.Status, '->', newStatus);
        console.log('[FULFILLMENT] Current status:', fulfillmentOrder.status);

        if (newStatus !== fulfillmentOrder.status) {
          console.log('[FULFILLMENT] Status changed, updating fulfillment order');
          await this.fulfillmentRepository.updateFulfillmentOrderStatus(fulfillmentOrder.id, newStatus as any, {
            trackingNumber: statusResponse.Tracking_Number,
            shippedAt: statusResponse.Shipping_Date,
          });

          if (newStatus === 'shipped' && statusResponse.Tracking_Number) {
            console.log('[FULFILLMENT] Order shipped, updating Fourthwall with tracking:', statusResponse.Tracking_Number);
            await this.updateFourthwallWithTracking(fulfillmentOrder.order_id, statusResponse.Tracking_Number);

            console.log('[FULFILLMENT] Updating order status to fulfilled');
            await this.orderRepository.updateOrderStatus(fulfillmentOrder.order_id, 'fulfilled');
          }

          console.log(`[FULFILLMENT] Updated Kunaki order ${fulfillmentOrder.provider_order_id} status to ${newStatus}`);
        }
      } catch (error) {
        console.error(`[FULFILLMENT] Error processing Kunaki status update for order ${fulfillmentOrder.id}:`, error);
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
        console.log('[FULFILLMENT] Order shipped, updating Fourthwall with tracking');
        await this.updateFourthwallWithTracking(
          fulfillmentOrder.order_id,
          processedWebhook.trackingNumber,
          processedWebhook.trackingUrl,
          processedWebhook.carrier,
        );

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

  private async updateFourthwallWithTracking(
    orderId: string,
    trackingNumber: string,
    trackingUrl?: string,
    carrier?: string,
  ): Promise<void> {
    console.log('[FULFILLMENT] Updating Fourthwall with tracking');
    console.log('[FULFILLMENT] Order ID:', orderId);
    console.log('[FULFILLMENT] Tracking:', trackingNumber);
    
    try {
      const order = await this.orderRepository.getOrderById(orderId);
      if (!order) {
        console.error(`[FULFILLMENT] Order not found for tracking update: ${orderId}`);
        return;
      }
      console.log('[FULFILLMENT] Found order, Fourthwall ID:', order.fourthwall_order_id);

      await this.fourthwallService.updateOrderWithTracking(
        order.fourthwall_order_id,
        trackingNumber,
        trackingUrl,
        carrier,
      );
      console.log('[FULFILLMENT] Successfully updated Fourthwall with tracking');
    } catch (error) {
      console.error(`[FULFILLMENT] Error updating Fourthwall with tracking for order ${orderId}:`, error);
      console.error('[FULFILLMENT] Error stack:', error instanceof Error ? error.stack : 'No stack');
    }
  }

}
