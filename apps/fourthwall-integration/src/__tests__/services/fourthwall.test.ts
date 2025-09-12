import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OrderRepository } from '../../repositories/order.js';
import { FourthwallService } from '../../services/fourthwall.js';
import { FourthwallWebhook } from '../../types/index.js';

const mockOrderRepository = {
  getOrderByFourthwallId: vi.fn(),
  createOrder: vi.fn(),
  createOrderItem: vi.fn(),
} as unknown as OrderRepository;

describe('FourthwallService', () => {
  let fourthwallService: FourthwallService;

  beforeEach(() => {
    vi.clearAllMocks();
    fourthwallService = new FourthwallService('test-api-key', mockOrderRepository);
  });

  describe('processWebhook', () => {
    it('should ignore non-order.paid webhooks', async () => {
      const webhook: FourthwallWebhook = {
        id: 'test-id',
        type: 'order.cancelled',
        data: {
          id: 'order-123',
          type: 'order',
          attributes: {} as any,
        },
        created_at: '2024-01-01T00:00:00Z',
      };

      await fourthwallService.processWebhook(webhook);

      expect(mockOrderRepository.getOrderByFourthwallId).not.toHaveBeenCalled();
    });

    it('should skip processing if order already exists', async () => {
      const webhook: FourthwallWebhook = {
        id: 'test-id',
        type: 'order.paid',
        data: {
          id: 'order-123',
          type: 'order',
          attributes: {
            id: 'order-123',
            status: 'paid',
            total: { amount: 2999, currency: 'USD' },
            customer: { email: 'test@example.com', name: 'Test User' },
            shipping_address: {
              line1: '123 Main St',
              city: 'Test City',
              postal_code: '12345',
              country: 'US',
            },
            line_items: [],
          },
        },
        created_at: '2024-01-01T00:00:00Z',
      };

      vi.mocked(mockOrderRepository.getOrderByFourthwallId).mockResolvedValue({
        id: 'existing-order-id',
      } as any);

      await fourthwallService.processWebhook(webhook);

      expect(mockOrderRepository.getOrderByFourthwallId).toHaveBeenCalledWith('order-123');
      expect(mockOrderRepository.createOrder).not.toHaveBeenCalled();
    });

    it('should create order and items for new paid order', async () => {
      const webhook: FourthwallWebhook = {
        id: 'test-id',
        type: 'order.paid',
        data: {
          id: 'order-123',
          type: 'order',
          attributes: {
            id: 'order-123',
            status: 'paid',
            total: { amount: 2999, currency: 'USD' },
            customer: { email: 'test@example.com', name: 'Test User' },
            shipping_address: {
              line1: '123 Main St',
              city: 'Test City',
              postal_code: '12345',
              country: 'US',
            },
            line_items: [
              {
                id: 'item-1',
                product_id: 'product-1',
                variant_id: 'variant-1',
                name: 'Test Product',
                quantity: 2,
                price: { amount: 1499, currency: 'USD' },
              },
            ],
          },
        },
        created_at: '2024-01-01T00:00:00Z',
      };

      const createdOrder = { id: 'new-order-id' };
      vi.mocked(mockOrderRepository.getOrderByFourthwallId).mockResolvedValue(null);
      vi.mocked(mockOrderRepository.createOrder).mockResolvedValue(createdOrder as any);
      vi.mocked(mockOrderRepository.createOrderItem).mockResolvedValue({} as any);

      await fourthwallService.processWebhook(webhook);

      expect(mockOrderRepository.createOrder).toHaveBeenCalledWith({
        fourthwall_order_id: 'order-123',
        customer_email: 'test@example.com',
        customer_name: 'Test User',
        shipping_address_line1: '123 Main St',
        shipping_address_line2: undefined,
        shipping_city: 'Test City',
        shipping_state: undefined,
        shipping_postal_code: '12345',
        shipping_country: 'US',
        order_total_cents: 2999,
        order_currency: 'USD',
        status: 'received',
      });

      expect(mockOrderRepository.createOrderItem).toHaveBeenCalledWith({
        order_id: 'new-order-id',
        fourthwall_product_id: 'product-1',
        fourthwall_variant_id: 'variant-1',
        product_name: 'Test Product',
        quantity: 2,
        unit_price_cents: 1499,
      });
    });
  });

  describe('validateWebhookSignature', () => {
    it('should return false for invalid signature', async () => {
      (globalThis as any).crypto = {
        subtle: {
          importKey: vi.fn().mockRejectedValue(new Error('Invalid key')),
        },
      };

      const result = await fourthwallService.validateWebhookSignature(
        'test payload',
        'invalid-signature',
        'test-secret',
      );

      expect(result).toBe(false);
    });
  });
});
