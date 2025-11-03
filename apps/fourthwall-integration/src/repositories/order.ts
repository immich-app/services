import { FulfillmentProvider, Order, OrderItem, OrderStatus } from '../types/index.js';
import { BaseRepository } from './base.js';

export class OrderRepository extends BaseRepository {
  async createOrder(order: Omit<Order, 'id' | 'created_at' | 'updated_at'>): Promise<Order> {
    console.log('[ORDER-REPO] Creating new order');
    console.log('[ORDER-REPO] Fourthwall ID:', order.fourthwall_order_id);
    console.log('[ORDER-REPO] Customer:', order.customer_email);

    const id = this.generateId();
    const timestamp = this.getCurrentTimestamp();

    console.log('[ORDER-REPO] Generated order ID:', id);

    const newOrder: Order = {
      ...order,
      id,
      created_at: timestamp,
      updated_at: timestamp,
    };

    await this.executeUpdate(
      `INSERT INTO orders (
        id, fourthwall_order_id, customer_email, customer_name, customer_phone,
        shipping_address_line1, shipping_address_line2, shipping_city,
        shipping_state, shipping_postal_code, shipping_country,
        order_total_cents, order_currency, status, fulfillment_provider,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        newOrder.id,
        newOrder.fourthwall_order_id,
        newOrder.customer_email,
        newOrder.customer_name,
        newOrder.customer_phone ?? null,
        newOrder.shipping_address_line1,
        newOrder.shipping_address_line2 ?? null,
        newOrder.shipping_city,
        newOrder.shipping_state ?? null,
        newOrder.shipping_postal_code,
        newOrder.shipping_country,
        newOrder.order_total_cents,
        newOrder.order_currency,
        newOrder.status,
        newOrder.fulfillment_provider ?? null,
        newOrder.created_at,
        newOrder.updated_at,
      ],
    );

    console.log('[ORDER-REPO] Order created successfully with ID:', newOrder.id);
    return newOrder;
  }

  async getOrderByFourthwallId(fourthwallOrderId: string): Promise<Order | null> {
    console.log('[ORDER-REPO] Looking up order by Fourthwall ID:', fourthwallOrderId);
    const order = await this.executeSingleQuery<Order>('SELECT * FROM orders WHERE fourthwall_order_id = ?', [
      fourthwallOrderId,
    ]);
    console.log('[ORDER-REPO] Order found:', order ? `ID ${order.id}` : 'none');
    return order;
  }

  async getOrderById(id: string): Promise<Order | null> {
    console.log('[ORDER-REPO] Getting order by ID:', id);
    const order = await this.executeSingleQuery<Order>('SELECT * FROM orders WHERE id = ?', [id]);
    console.log('[ORDER-REPO] Order found:', order ? 'yes' : 'no');
    return order;
  }

  async updateOrderStatus(id: string, status: OrderStatus): Promise<void> {
    console.log('[ORDER-REPO] Updating order status:', id, '->', status);
    await this.executeUpdate('UPDATE orders SET status = ?, updated_at = ? WHERE id = ?', [
      status,
      this.getCurrentTimestamp(),
      id,
    ]);
  }

  async updateOrderFulfillmentProvider(id: string, provider: FulfillmentProvider): Promise<void> {
    console.log('[ORDER-REPO] Setting fulfillment provider for order:', id, '->', provider);
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
    console.log('[ORDER-REPO] Creating order item for order:', orderItem.order_id);
    console.log('[ORDER-REPO] Product:', orderItem.product_name, 'Qty:', orderItem.quantity);

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
        newOrderItem.fourthwall_variant_id ?? null,
        newOrderItem.product_name,
        newOrderItem.quantity,
        newOrderItem.unit_price_cents,
      ],
    );

    console.log('[ORDER-REPO] Order item created with ID:', newOrderItem.id);
    return newOrderItem;
  }

  async getOrderItems(orderId: string): Promise<OrderItem[]> {
    console.log('[ORDER-REPO] Getting items for order:', orderId);
    const result = await this.executeQuery<OrderItem>('SELECT * FROM order_items WHERE order_id = ?', [orderId]);
    const items = result.results || [];
    console.log('[ORDER-REPO] Found', items.length, 'items for order');
    return items;
  }

  async getOrderWithItems(orderId: string): Promise<{ order: Order; items: OrderItem[] } | null> {
    console.log('[ORDER-REPO] Getting order with items:', orderId);
    const order = await this.getOrderById(orderId);
    if (!order) {
      console.log('[ORDER-REPO] Order not found');
      return null;
    }

    const items = await this.getOrderItems(orderId);
    console.log('[ORDER-REPO] Returning order with', items.length, 'items');
    return { order, items };
  }
}
