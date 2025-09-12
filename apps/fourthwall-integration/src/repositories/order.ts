import { FulfillmentProvider, Order, OrderItem, OrderStatus } from '../types/index.js';
import { BaseRepository } from './base.js';

export class OrderRepository extends BaseRepository {
  async createOrder(order: Omit<Order, 'id' | 'created_at' | 'updated_at'>): Promise<Order> {
    const id = this.generateId();
    const timestamp = this.getCurrentTimestamp();

    const newOrder: Order = {
      ...order,
      id,
      created_at: timestamp,
      updated_at: timestamp,
    };

    await this.executeUpdate(
      `INSERT INTO orders (
        id, fourthwall_order_id, customer_email, customer_name,
        shipping_address_line1, shipping_address_line2, shipping_city,
        shipping_state, shipping_postal_code, shipping_country,
        order_total_cents, order_currency, status, fulfillment_provider,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        newOrder.id,
        newOrder.fourthwall_order_id,
        newOrder.customer_email,
        newOrder.customer_name,
        newOrder.shipping_address_line1,
        newOrder.shipping_address_line2,
        newOrder.shipping_city,
        newOrder.shipping_state,
        newOrder.shipping_postal_code,
        newOrder.shipping_country,
        newOrder.order_total_cents,
        newOrder.order_currency,
        newOrder.status,
        newOrder.fulfillment_provider,
        newOrder.created_at,
        newOrder.updated_at,
      ],
    );

    return newOrder;
  }

  async getOrderByFourthwallId(fourthwallOrderId: string): Promise<Order | null> {
    return await this.executeSingleQuery<Order>('SELECT * FROM orders WHERE fourthwall_order_id = ?', [
      fourthwallOrderId,
    ]);
  }

  async getOrderById(id: string): Promise<Order | null> {
    return await this.executeSingleQuery<Order>('SELECT * FROM orders WHERE id = ?', [id]);
  }

  async updateOrderStatus(id: string, status: OrderStatus): Promise<void> {
    await this.executeUpdate('UPDATE orders SET status = ?, updated_at = ? WHERE id = ?', [
      status,
      this.getCurrentTimestamp(),
      id,
    ]);
  }

  async updateOrderFulfillmentProvider(id: string, provider: FulfillmentProvider): Promise<void> {
    await this.executeUpdate('UPDATE orders SET fulfillment_provider = ?, updated_at = ? WHERE id = ?', [
      provider,
      this.getCurrentTimestamp(),
      id,
    ]);
  }

  async getOrdersWithoutFulfillmentProvider(): Promise<Order[]> {
    const result = await this.executeQuery<Order>(
      'SELECT * FROM orders WHERE fulfillment_provider IS NULL AND status = ? ORDER BY created_at ASC',
      ['received'],
    );
    return result.results || [];
  }

  async createOrderItem(orderItem: Omit<OrderItem, 'id'>): Promise<OrderItem> {
    const id = this.generateId();

    const newOrderItem: OrderItem = {
      ...orderItem,
      id,
    };

    await this.executeUpdate(
      `INSERT INTO order_items (
        id, order_id, fourthwall_product_id, fourthwall_variant_id,
        product_name, quantity, unit_price_cents
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        newOrderItem.id,
        newOrderItem.order_id,
        newOrderItem.fourthwall_product_id,
        newOrderItem.fourthwall_variant_id,
        newOrderItem.product_name,
        newOrderItem.quantity,
        newOrderItem.unit_price_cents,
      ],
    );

    return newOrderItem;
  }

  async getOrderItems(orderId: string): Promise<OrderItem[]> {
    const result = await this.executeQuery<OrderItem>('SELECT * FROM order_items WHERE order_id = ?', [orderId]);
    return result.results || [];
  }

  async getOrderWithItems(orderId: string): Promise<{ order: Order; items: OrderItem[] } | null> {
    const order = await this.getOrderById(orderId);
    if (!order) {
      return null;
    }

    const items = await this.getOrderItems(orderId);
    return { order, items };
  }
}
