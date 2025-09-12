import { FulfillmentOrder, FulfillmentProvider, FulfillmentStatus } from '../types/index.js';
import { BaseRepository } from './base.js';

export class FulfillmentRepository extends BaseRepository {
  async createFulfillmentOrder(
    fulfillmentOrder: Omit<FulfillmentOrder, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<FulfillmentOrder> {
    const id = this.generateId();
    const timestamp = this.getCurrentTimestamp();

    const newFulfillmentOrder: FulfillmentOrder = {
      ...fulfillmentOrder,
      id,
      created_at: timestamp,
      updated_at: timestamp,
    };

    await this.executeUpdate(
      `INSERT INTO fulfillment_orders (
        id, order_id, provider, provider_order_id, status,
        tracking_number, tracking_url, shipping_carrier,
        submitted_at, shipped_at, error_message, retry_count,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        newFulfillmentOrder.id,
        newFulfillmentOrder.order_id,
        newFulfillmentOrder.provider,
        newFulfillmentOrder.provider_order_id,
        newFulfillmentOrder.status,
        newFulfillmentOrder.tracking_number,
        newFulfillmentOrder.tracking_url,
        newFulfillmentOrder.shipping_carrier,
        newFulfillmentOrder.submitted_at,
        newFulfillmentOrder.shipped_at,
        newFulfillmentOrder.error_message,
        newFulfillmentOrder.retry_count,
        newFulfillmentOrder.created_at,
        newFulfillmentOrder.updated_at,
      ],
    );

    return newFulfillmentOrder;
  }

  async getFulfillmentOrderById(id: string): Promise<FulfillmentOrder | null> {
    return await this.executeSingleQuery<FulfillmentOrder>('SELECT * FROM fulfillment_orders WHERE id = ?', [id]);
  }

  async getFulfillmentOrderByProviderOrderId(
    providerOrderId: string,
    provider: FulfillmentProvider,
  ): Promise<FulfillmentOrder | null> {
    return await this.executeSingleQuery<FulfillmentOrder>(
      'SELECT * FROM fulfillment_orders WHERE provider_order_id = ? AND provider = ?',
      [providerOrderId, provider],
    );
  }

  async getFulfillmentOrdersByOrderId(orderId: string): Promise<FulfillmentOrder[]> {
    const result = await this.executeQuery<FulfillmentOrder>('SELECT * FROM fulfillment_orders WHERE order_id = ?', [
      orderId,
    ]);
    return result.results || [];
  }

  async updateFulfillmentOrderStatus(
    id: string,
    status: FulfillmentStatus,
    options: {
      providerOrderId?: string;
      trackingNumber?: string;
      trackingUrl?: string;
      shippingCarrier?: string;
      errorMessage?: string;
      shippedAt?: string;
    } = {},
  ): Promise<void> {
    const updates: string[] = ['status = ?', 'updated_at = ?'];
    const params: any[] = [status, this.getCurrentTimestamp()];

    if (options.providerOrderId !== undefined) {
      updates.push('provider_order_id = ?');
      params.push(options.providerOrderId);
    }

    if (options.trackingNumber !== undefined) {
      updates.push('tracking_number = ?');
      params.push(options.trackingNumber);
    }

    if (options.trackingUrl !== undefined) {
      updates.push('tracking_url = ?');
      params.push(options.trackingUrl);
    }

    if (options.shippingCarrier !== undefined) {
      updates.push('shipping_carrier = ?');
      params.push(options.shippingCarrier);
    }

    if (options.errorMessage !== undefined) {
      updates.push('error_message = ?');
      params.push(options.errorMessage);
    }

    if (options.shippedAt !== undefined) {
      updates.push('shipped_at = ?');
      params.push(options.shippedAt);
    }

    if (status === 'submitted' && !options.providerOrderId) {
      updates.push('submitted_at = ?');
      params.push(this.getCurrentTimestamp());
    }

    params.push(id);

    await this.executeUpdate(`UPDATE fulfillment_orders SET ${updates.join(', ')} WHERE id = ?`, params);
  }

  async incrementRetryCount(id: string): Promise<void> {
    await this.executeUpdate(
      'UPDATE fulfillment_orders SET retry_count = retry_count + 1, updated_at = ? WHERE id = ?',
      [this.getCurrentTimestamp(), id],
    );
  }

  async getPendingKunakiOrders(): Promise<FulfillmentOrder[]> {
    const result = await this.executeQuery<FulfillmentOrder>(
      `SELECT * FROM fulfillment_orders 
       WHERE provider = 'kunaki' 
       AND status IN ('submitted', 'processing') 
       AND provider_order_id IS NOT NULL
       ORDER BY created_at ASC`,
      [],
    );
    return result.results || [];
  }

  async getRetryableFulfillmentOrders(maxRetries = 3): Promise<FulfillmentOrder[]> {
    const result = await this.executeQuery<FulfillmentOrder>(
      `SELECT * FROM fulfillment_orders 
       WHERE status = 'failed' 
       AND retry_count < ? 
       ORDER BY created_at ASC`,
      [maxRetries],
    );
    return result.results || [];
  }
}
