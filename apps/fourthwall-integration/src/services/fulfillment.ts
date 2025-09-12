import { FulfillmentRepository, OrderRepository } from '../repositories/index.js';
import { Env, FulfillmentProvider, FulfillmentResult, Order, OrderItem } from '../types/index.js';
import { CDClickService, FourthwallService, KunakiService } from './index.js';

export class FulfillmentService {
  private kunakiService: KunakiService;
  private cdclickService: CDClickService;
  private fourthwallService: FourthwallService;

  constructor(
    private env: Env,
    private orderRepository: OrderRepository,
    private fulfillmentRepository: FulfillmentRepository,
  ) {
    this.kunakiService = new KunakiService(env.KUNAKI_API_USERNAME, env.KUNAKI_API_PASSWORD);
    this.cdclickService = new CDClickService(env.CDCLICK_API_KEY);
    this.fourthwallService = new FourthwallService(env.FOURTHWALL_API_KEY, orderRepository);
  }

  async processOrder(orderId: string): Promise<void> {
    try {
      const orderWithItems = await this.orderRepository.getOrderWithItems(orderId);
      if (!orderWithItems) {
        throw new Error(`Order not found: ${orderId}`);
      }

      const { order, items } = orderWithItems;

      if (order.status !== 'received') {
        console.log(`Order ${orderId} is not in 'received' status, skipping`);
        return;
      }

      const provider = this.determineFulfillmentProvider(order);

      await this.orderRepository.updateOrderFulfillmentProvider(orderId, provider);
      await this.orderRepository.updateOrderStatus(orderId, 'processing');

      const fulfillmentOrder = await this.fulfillmentRepository.createFulfillmentOrder({
        order_id: orderId,
        provider,
        status: 'pending',
        retry_count: 0,
      });

      const result = await this.submitToProvider(provider, order, items);

      if (result.success) {
        await this.fulfillmentRepository.updateFulfillmentOrderStatus(fulfillmentOrder.id, 'submitted', {
          providerOrderId: result.provider_order_id,
          trackingNumber: result.tracking_number,
          trackingUrl: result.tracking_url,
          shippingCarrier: result.carrier,
        });

        console.log(`Successfully submitted order ${orderId} to ${provider}`);
      } else {
        await this.fulfillmentRepository.updateFulfillmentOrderStatus(fulfillmentOrder.id, 'failed', {
          errorMessage: result.error,
        });

        console.error(`Failed to submit order ${orderId} to ${provider}: ${result.error}`);

        await this.enqueueForRetry(orderId);
      }
    } catch (error) {
      console.error(`Error processing order ${orderId}:`, error);
      await this.orderRepository.updateOrderStatus(orderId, 'received');
    }
  }

  private determineFulfillmentProvider(order: Order): FulfillmentProvider {
    if (this.kunakiService.canFulfillOrder(order)) {
      return 'kunaki';
    } else if (this.cdclickService.canFulfillOrder(order)) {
      return 'cdclick-europe';
    } else {
      throw new Error(`No fulfillment provider available for country: ${order.shipping_country}`);
    }
  }

  private async submitToProvider(
    provider: FulfillmentProvider,
    order: Order,
    items: OrderItem[],
  ): Promise<FulfillmentResult> {
    switch (provider) {
      case 'kunaki': {
        return await this.kunakiService.submitOrder(order, items);
      }
      case 'cdclick-europe': {
        return await this.cdclickService.submitOrder(order, items);
      }
      default: {
        throw new Error(`Unknown provider: ${provider}`);
      }
    }
  }

  async processKunakiStatusUpdates(): Promise<void> {
    const pendingOrders = await this.fulfillmentRepository.getPendingKunakiOrders();

    for (const fulfillmentOrder of pendingOrders) {
      try {
        if (!fulfillmentOrder.provider_order_id) {
          console.log(`Kunaki order ${fulfillmentOrder.id} has no provider order ID, skipping`);
          continue;
        }

        const statusResponse = await this.kunakiService.checkOrderStatus(fulfillmentOrder.provider_order_id);

        if (statusResponse.Error) {
          console.error(`Error checking Kunaki order ${fulfillmentOrder.provider_order_id}: ${statusResponse.Error}`);
          continue;
        }

        const newStatus = this.kunakiService.mapKunakiStatusToFulfillmentStatus(statusResponse.Status);

        if (newStatus !== fulfillmentOrder.status) {
          await this.fulfillmentRepository.updateFulfillmentOrderStatus(fulfillmentOrder.id, newStatus as any, {
            trackingNumber: statusResponse.Tracking_Number,
            shippedAt: statusResponse.Shipping_Date,
          });

          if (newStatus === 'shipped' && statusResponse.Tracking_Number) {
            await this.updateFourthwallWithTracking(fulfillmentOrder.order_id, statusResponse.Tracking_Number);

            await this.orderRepository.updateOrderStatus(fulfillmentOrder.order_id, 'fulfilled');
          }

          console.log(`Updated Kunaki order ${fulfillmentOrder.provider_order_id} status to ${newStatus}`);
        }
      } catch (error) {
        console.error(`Error processing Kunaki status update for order ${fulfillmentOrder.id}:`, error);
      }
    }
  }

  async processCDClickWebhook(webhook: any): Promise<void> {
    try {
      const processedWebhook = this.cdclickService.processWebhook(webhook);

      const fulfillmentOrder = await this.fulfillmentRepository.getFulfillmentOrderByProviderOrderId(
        processedWebhook.orderId,
        'cdclick-europe',
      );

      if (!fulfillmentOrder) {
        console.log(`No fulfillment order found for CDClick order ${processedWebhook.orderId}`);
        return;
      }

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
        await this.updateFourthwallWithTracking(
          fulfillmentOrder.order_id,
          processedWebhook.trackingNumber,
          processedWebhook.trackingUrl,
          processedWebhook.carrier,
        );

        await this.orderRepository.updateOrderStatus(fulfillmentOrder.order_id, 'fulfilled');
      }

      console.log(`Processed CDClick webhook for order ${processedWebhook.orderId}`);
    } catch (error) {
      console.error('Error processing CDClick webhook:', error);
      throw error;
    }
  }

  async retryFailedOrders(): Promise<void> {
    const retryableOrders = await this.fulfillmentRepository.getRetryableFulfillmentOrders();

    for (const fulfillmentOrder of retryableOrders) {
      try {
        await this.fulfillmentRepository.incrementRetryCount(fulfillmentOrder.id);

        const orderWithItems = await this.orderRepository.getOrderWithItems(fulfillmentOrder.order_id);
        if (!orderWithItems) {
          console.error(`Order not found for retry: ${fulfillmentOrder.order_id}`);
          continue;
        }

        const { order, items } = orderWithItems;
        const result = await this.submitToProvider(fulfillmentOrder.provider, order, items);

        if (result.success) {
          await this.fulfillmentRepository.updateFulfillmentOrderStatus(fulfillmentOrder.id, 'submitted', {
            providerOrderId: result.provider_order_id,
            trackingNumber: result.tracking_number,
            trackingUrl: result.tracking_url,
            shippingCarrier: result.carrier,
            errorMessage: undefined,
          });

          console.log(`Successfully retried order ${fulfillmentOrder.order_id}`);
        } else {
          await this.fulfillmentRepository.updateFulfillmentOrderStatus(fulfillmentOrder.id, 'failed', {
            errorMessage: result.error,
          });

          console.error(`Retry failed for order ${fulfillmentOrder.order_id}: ${result.error}`);
        }
      } catch (error) {
        console.error(`Error retrying order ${fulfillmentOrder.order_id}:`, error);
      }
    }
  }

  private async updateFourthwallWithTracking(
    orderId: string,
    trackingNumber: string,
    trackingUrl?: string,
    carrier?: string,
  ): Promise<void> {
    try {
      const order = await this.orderRepository.getOrderById(orderId);
      if (!order) {
        console.error(`Order not found for tracking update: ${orderId}`);
        return;
      }

      await this.fourthwallService.updateOrderWithTracking(
        order.fourthwall_order_id,
        trackingNumber,
        trackingUrl,
        carrier,
      );
    } catch (error) {
      console.error(`Error updating Fourthwall with tracking for order ${orderId}:`, error);
    }
  }

  private async enqueueForRetry(orderId: string): Promise<void> {
    try {
      await this.env.FULFILLMENT_QUEUE.send({
        type: 'fulfillment',
        data: { orderId },
        retry_count: 0,
      });
    } catch (error) {
      console.error(`Error enqueueing order ${orderId} for retry:`, error);
    }
  }
}
