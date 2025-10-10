import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FulfillmentRepository, OrderRepository } from '../../repositories/index.js';
import { FulfillmentService } from '../../services/fulfillment.js';
import { Env, Order, OrderItem } from '../../types/index.js';

// Mock the queue and other services
const mockEnv = {
  EMAIL_QUEUE: {
    send: vi.fn(),
  },
  KUNAKI_API_USERNAME: 'test-user',
  KUNAKI_API_PASSWORD: 'test-pass',
  CDCLICK_API_KEY: 'test-key',
  FOURTHWALL_USERNAME: 'test-fw-user',
  FOURTHWALL_PASSWORD: 'test-fw-pass',
  ENVIRONMENT: 'test',
} as unknown as Env;

const mockOrderRepository = {
  getOrderWithItems: vi.fn(),
  updateOrderFulfillmentProvider: vi.fn(),
  updateOrderStatus: vi.fn(),
} as unknown as OrderRepository;

const mockFulfillmentRepository = {
  getFulfillmentOrderByOrderId: vi.fn(),
  createFulfillmentOrder: vi.fn(),
  updateFulfillmentOrderStatus: vi.fn(),
} as unknown as FulfillmentRepository;

describe('FulfillmentService - Product Key Integration', () => {
  let fulfillmentService: FulfillmentService;

  beforeEach(() => {
    vi.clearAllMocks();
    fulfillmentService = new FulfillmentService(mockEnv, mockOrderRepository, mockFulfillmentRepository);
  });

  describe('processProductKeyVariants', () => {
    it('should queue email for client key variant', async () => {
      const order: Order = {
        id: 'order-123',
        fourthwall_order_id: 'fw-order-123',
        customer_email: 'test@example.com',
        customer_name: 'John Doe',
        shipping_address_line1: '123 Main St',
        shipping_city: 'Test City',
        shipping_postal_code: '12345',
        shipping_country: 'US',
        order_total_cents: 5000,
        order_currency: 'USD',
        status: 'received',
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-01T00:00:00Z',
      };

      const items: OrderItem[] = [
        {
          id: 'item-1',
          order_id: 'order-123',
          fourthwall_product_id: 'product-123',
          fourthwall_variant_id: '1a67c752-4293-4b60-b4c7-fc9ad060d9eb', // Client key variant
          product_name: 'Immich Retro CD with Client Key',
          quantity: 1,
          unit_price_cents: 5000,
        },
      ];

      // Mock the dependencies to make the fulfillment succeed
      (mockOrderRepository.getOrderWithItems as any).mockResolvedValue({ order, items });
      (mockFulfillmentRepository.getFulfillmentOrderByOrderId as any).mockResolvedValue(null);
      (mockFulfillmentRepository.createFulfillmentOrder as any).mockResolvedValue({
        id: 'fulfillment-123',
        order_id: 'order-123',
        provider: 'kunaki',
        status: 'pending',
        retry_count: 0,
        tracking_uploaded_to_fourthwall: false,
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-01T00:00:00Z',
      });

      // Mock the submitToProvider to return success with provider order ID
      const mockSubmitToProvider = vi.spyOn(fulfillmentService as any, 'submitToProvider');
      mockSubmitToProvider.mockResolvedValue({
        success: true,
        provider_order_id: 'provider-123',
      });

      // Mock the Fourthwall service
      const mockFourthwallService = {
        createFulfillment: vi.fn().mockResolvedValue({}),
      };
      (fulfillmentService as any).fourthwallService = mockFourthwallService;

      await fulfillmentService.processOrder('order-123');

      // Verify that an email was queued for the client key
      expect(mockEnv.EMAIL_QUEUE.send).toHaveBeenCalledWith({
        type: 'product_key_email',
        data: {
          orderId: 'order-123',
          customerEmail: 'test@example.com',
          customerName: 'John Doe',
          keyType: 'client',
          keyValue: '',
          activationKey: '',
        },
      });
    });

    it('should queue email for server key variant', async () => {
      const order: Order = {
        id: 'order-456',
        fourthwall_order_id: 'fw-order-456',
        customer_email: 'admin@example.com',
        customer_name: 'Jane Admin',
        shipping_address_line1: '456 Admin St',
        shipping_city: 'Admin City',
        shipping_postal_code: '67890',
        shipping_country: 'US',
        order_total_cents: 10_000,
        order_currency: 'USD',
        status: 'received',
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-01T00:00:00Z',
      };

      const items: OrderItem[] = [
        {
          id: 'item-2',
          order_id: 'order-456',
          fourthwall_product_id: 'product-456',
          fourthwall_variant_id: '9f1c1bce-dc6f-4471-96b3-e0b2f5a5b0fa', // Server key variant
          product_name: 'Immich Retro CD with Server Key',
          quantity: 1,
          unit_price_cents: 10_000,
        },
      ];

      // Mock the dependencies to make the fulfillment succeed
      (mockOrderRepository.getOrderWithItems as any).mockResolvedValue({ order, items });
      (mockFulfillmentRepository.getFulfillmentOrderByOrderId as any).mockResolvedValue(null);
      (mockFulfillmentRepository.createFulfillmentOrder as any).mockResolvedValue({
        id: 'fulfillment-456',
        order_id: 'order-456',
        provider: 'kunaki',
        status: 'pending',
        retry_count: 0,
        tracking_uploaded_to_fourthwall: false,
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-01T00:00:00Z',
      });

      // Mock the submitToProvider to return success with provider order ID
      const mockSubmitToProvider = vi.spyOn(fulfillmentService as any, 'submitToProvider');
      mockSubmitToProvider.mockResolvedValue({
        success: true,
        provider_order_id: 'provider-456',
      });

      // Mock the Fourthwall service
      const mockFourthwallService = {
        createFulfillment: vi.fn().mockResolvedValue({}),
      };
      (fulfillmentService as any).fourthwallService = mockFourthwallService;

      await fulfillmentService.processOrder('order-456');

      // Verify that an email was queued for the server key
      expect(mockEnv.EMAIL_QUEUE.send).toHaveBeenCalledWith({
        type: 'product_key_email',
        data: {
          orderId: 'order-456',
          customerEmail: 'admin@example.com',
          customerName: 'Jane Admin',
          keyType: 'server',
          keyValue: '',
          activationKey: '',
        },
      });
    });

    it('should queue multiple emails for quantity > 1', async () => {
      const order: Order = {
        id: 'order-789',
        fourthwall_order_id: 'fw-order-789',
        customer_email: 'bulk@example.com',
        customer_name: 'Bulk Buyer',
        shipping_address_line1: '789 Bulk St',
        shipping_city: 'Bulk City',
        shipping_postal_code: '11111',
        shipping_country: 'US',
        order_total_cents: 15_000,
        order_currency: 'USD',
        status: 'received',
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-01T00:00:00Z',
      };

      const items: OrderItem[] = [
        {
          id: 'item-3',
          order_id: 'order-789',
          fourthwall_product_id: 'product-789',
          fourthwall_variant_id: '1a67c752-4293-4b60-b4c7-fc9ad060d9eb', // Client key variant
          product_name: 'Immich Retro CD with Client Key',
          quantity: 3, // Multiple quantity
          unit_price_cents: 5000,
        },
      ];

      // Mock the dependencies
      (mockOrderRepository.getOrderWithItems as any).mockResolvedValue({ order, items });
      (mockFulfillmentRepository.getFulfillmentOrderByOrderId as any).mockResolvedValue(null);
      (mockFulfillmentRepository.createFulfillmentOrder as any).mockResolvedValue({
        id: 'fulfillment-789',
        order_id: 'order-789',
        provider: 'kunaki',
        status: 'pending',
        retry_count: 0,
        tracking_uploaded_to_fourthwall: false,
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-01T00:00:00Z',
      });

      const mockSubmitToProvider = vi.spyOn(fulfillmentService as any, 'submitToProvider');
      mockSubmitToProvider.mockResolvedValue({
        success: true,
        provider_order_id: 'provider-789',
      });

      const mockFourthwallService = {
        createFulfillment: vi.fn().mockResolvedValue({}),
      };
      (fulfillmentService as any).fourthwallService = mockFourthwallService;

      await fulfillmentService.processOrder('order-789');

      // Verify that 3 emails were queued (one for each quantity)
      expect(mockEnv.EMAIL_QUEUE.send).toHaveBeenCalledTimes(3);

      for (let i = 0; i < 3; i++) {
        expect(mockEnv.EMAIL_QUEUE.send).toHaveBeenNthCalledWith(i + 1, {
          type: 'product_key_email',
          data: {
            orderId: 'order-789',
            customerEmail: 'bulk@example.com',
            customerName: 'Bulk Buyer',
            keyType: 'client',
            keyValue: '',
            activationKey: '',
          },
        });
      }
    });

    it('should not queue emails for non-key variants', async () => {
      const order: Order = {
        id: 'order-999',
        fourthwall_order_id: 'fw-order-999',
        customer_email: 'regular@example.com',
        customer_name: 'Regular Customer',
        shipping_address_line1: '999 Regular St',
        shipping_city: 'Regular City',
        shipping_postal_code: '99999',
        shipping_country: 'US',
        order_total_cents: 3000,
        order_currency: 'USD',
        status: 'received',
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-01T00:00:00Z',
      };

      const items: OrderItem[] = [
        {
          id: 'item-4',
          order_id: 'order-999',
          fourthwall_product_id: 'product-999',
          fourthwall_variant_id: 'some-other-variant-id', // Not a key variant
          product_name: 'Regular Immich Retro CD',
          quantity: 1,
          unit_price_cents: 3000,
        },
      ];

      // Mock the dependencies
      (mockOrderRepository.getOrderWithItems as any).mockResolvedValue({ order, items });
      (mockFulfillmentRepository.getFulfillmentOrderByOrderId as any).mockResolvedValue(null);
      (mockFulfillmentRepository.createFulfillmentOrder as any).mockResolvedValue({
        id: 'fulfillment-999',
        order_id: 'order-999',
        provider: 'kunaki',
        status: 'pending',
        retry_count: 0,
        tracking_uploaded_to_fourthwall: false,
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-01T00:00:00Z',
      });

      const mockSubmitToProvider = vi.spyOn(fulfillmentService as any, 'submitToProvider');
      mockSubmitToProvider.mockResolvedValue({
        success: true,
        provider_order_id: 'provider-999',
      });

      const mockFourthwallService = {
        createFulfillment: vi.fn().mockResolvedValue({}),
      };
      (fulfillmentService as any).fourthwallService = mockFourthwallService;

      await fulfillmentService.processOrder('order-999');

      // Verify that no emails were queued
      expect(mockEnv.EMAIL_QUEUE.send).not.toHaveBeenCalled();
    });
  });
});
