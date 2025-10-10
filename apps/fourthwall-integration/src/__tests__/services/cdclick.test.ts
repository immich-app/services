import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CDClickService } from '../../services/cdclick.js';
import { CDClickWebhook, Order } from '../../types/index.js';

const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

describe('CDClickService', () => {
  let cdclickService: CDClickService;

  beforeEach(() => {
    vi.clearAllMocks();
    cdclickService = new CDClickService('test-api-key');
  });

  describe('canFulfillOrder', () => {
    it('should return false for US orders', () => {
      const usOrder: Order = {
        shipping_country: 'US',
      } as Order;

      expect(cdclickService.canFulfillOrder(usOrder)).toBe(false);
    });

    it('should return false for USA orders', () => {
      const usaOrder: Order = {
        shipping_country: 'USA',
      } as Order;

      expect(cdclickService.canFulfillOrder(usaOrder)).toBe(false);
    });

    it('should return true for non-US orders', () => {
      const canadaOrder: Order = {
        shipping_country: 'CA',
      } as Order;

      expect(cdclickService.canFulfillOrder(canadaOrder)).toBe(true);
    });

    it('should return true for European orders', () => {
      const ukOrder: Order = {
        shipping_country: 'UK',
      } as Order;

      expect(cdclickService.canFulfillOrder(ukOrder)).toBe(true);
    });
  });

  describe('mapCDClickStatusToFulfillmentStatus', () => {
    it('should map CDClick statuses correctly', () => {
      expect(cdclickService.mapCDClickStatusToFulfillmentStatus('pending')).toBe('pending');
      expect(cdclickService.mapCDClickStatusToFulfillmentStatus('accepted')).toBe('processing');
      expect(cdclickService.mapCDClickStatusToFulfillmentStatus('processing')).toBe('processing');
      expect(cdclickService.mapCDClickStatusToFulfillmentStatus('shipped')).toBe('shipped');
      expect(cdclickService.mapCDClickStatusToFulfillmentStatus('dispatched')).toBe('shipped');
      expect(cdclickService.mapCDClickStatusToFulfillmentStatus('delivered')).toBe('delivered');
      expect(cdclickService.mapCDClickStatusToFulfillmentStatus('cancelled')).toBe('cancelled');
      expect(cdclickService.mapCDClickStatusToFulfillmentStatus('failed')).toBe('failed');
      expect(cdclickService.mapCDClickStatusToFulfillmentStatus('unknown')).toBe('processing');
    });
  });

  describe('submitOrder', () => {
    it('should handle order with no SKU mappings gracefully', async () => {
      const mockOrder: Order = {
        id: 'order-1',
        customer_name: 'John Doe',
        shipping_address_line1: '123 Main St',
        shipping_city: 'Test City',
        shipping_postal_code: '12345',
        shipping_country: 'UK',
      } as Order;

      const mockOrderItems = [
        {
          fourthwall_product_id: 'product-1',
          quantity: 2,
          product_name: 'Test Product',
        },
      ] as any;

      const result = await cdclickService.submitOrder(mockOrder, mockOrderItems);

      // When no SKU mappings exist, we return success but no provider_order_id
      expect(result.success).toBe(true);
      expect(result.provider_order_id).toBeUndefined();
    });
  });

  describe('processWebhook', () => {
    it('should process webhook correctly', () => {
      const webhook: CDClickWebhook = {
        order_id: 'CDCLICK123',
        status: 'shipped',
        tracking_number: 'TRACK123',
        tracking_url: 'https://tracking.example.com/TRACK123',
        carrier: 'DHL',
        shipped_at: '2024-01-01T10:00:00Z',
        event_type: 'order.shipped',
      };

      const result = cdclickService.processWebhook(webhook);

      expect(result.orderId).toBe('CDCLICK123');
      expect(result.status).toBe('shipped');
      expect(result.trackingNumber).toBe('TRACK123');
      expect(result.trackingUrl).toBe('https://tracking.example.com/TRACK123');
      expect(result.carrier).toBe('DHL');
      expect(result.shippedAt).toBe('2024-01-01T10:00:00Z');
    });
  });

  describe('getOrderStatus', () => {
    it('should fetch order status successfully', async () => {
      const mockResponse = {
        success: true,
        errorText: '',
        orders: [
          {
            id: 123,
            custom_id: 'order-123',
            orderDate: '2024-01-01',
            shipping_address: {
              first_name: 'John',
              last_name: 'Doe',
              email: 'john@example.com',
              address_street: '123 Main St',
              zip_code: '12345',
              city: 'Test City',
              country_code: 'UK',
              phone_number: '1234567890',
            },
            isShipped: false,
            flag: false,
            shipping_fee: 10,
            box_and_handling_fee: 2.5,
          },
        ],
      };

      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      });

      const result = await cdclickService.getOrderStatus('123');

      expect(result).toEqual(mockResponse);
      expect(mockFetch).toHaveBeenCalledWith(
        'https://wall.cdclick-europe.com/API/orders/123',
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'Bearer test-api-key',
          }),
        }),
      );
    });

    it('should throw error for non-ok responses', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 404,
      });

      await expect(cdclickService.getOrderStatus('NONEXISTENT')).rejects.toThrow('CDClick API error: 404');
    });
  });
});
