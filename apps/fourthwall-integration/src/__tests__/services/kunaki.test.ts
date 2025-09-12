import { beforeEach, describe, expect, it, vi } from 'vitest';
import { KunakiService } from '../../services/kunaki.js';
import { Order } from '../../types/index.js';

const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

describe('KunakiService', () => {
  let kunakiService: KunakiService;

  beforeEach(() => {
    vi.clearAllMocks();
    kunakiService = new KunakiService('test-user', 'test-pass');
  });

  describe('canFulfillOrder', () => {
    it('should return true for US orders', () => {
      const usOrder: Order = {
        shipping_country: 'US',
      } as Order;

      expect(kunakiService.canFulfillOrder(usOrder)).toBe(true);
    });

    it('should return true for USA orders', () => {
      const usaOrder: Order = {
        shipping_country: 'USA',
      } as Order;

      expect(kunakiService.canFulfillOrder(usaOrder)).toBe(true);
    });

    it('should return true for United States orders', () => {
      const unitedStatesOrder: Order = {
        shipping_country: 'UNITED STATES',
      } as Order;

      expect(kunakiService.canFulfillOrder(unitedStatesOrder)).toBe(true);
    });

    it('should return false for non-US orders', () => {
      const canadaOrder: Order = {
        shipping_country: 'CA',
      } as Order;

      expect(kunakiService.canFulfillOrder(canadaOrder)).toBe(false);
    });
  });

  describe('mapKunakiStatusToFulfillmentStatus', () => {
    it('should map Kunaki statuses correctly', () => {
      expect(kunakiService.mapKunakiStatusToFulfillmentStatus('Success')).toBe('processing');
      expect(kunakiService.mapKunakiStatusToFulfillmentStatus('Processing')).toBe('processing');
      expect(kunakiService.mapKunakiStatusToFulfillmentStatus('Shipped')).toBe('shipped');
      expect(kunakiService.mapKunakiStatusToFulfillmentStatus('Delivered')).toBe('delivered');
      expect(kunakiService.mapKunakiStatusToFulfillmentStatus('Cancelled')).toBe('cancelled');
      expect(kunakiService.mapKunakiStatusToFulfillmentStatus('Error')).toBe('failed');
      expect(kunakiService.mapKunakiStatusToFulfillmentStatus('Unknown')).toBe('processing');
    });
  });

  describe('submitOrder', () => {
    it('should handle successful order submission', async () => {
      const mockOrder: Order = {
        id: 'order-1',
        customer_name: 'John Doe',
        shipping_address_line1: '123 Main St',
        shipping_city: 'Test City',
        shipping_postal_code: '12345',
        shipping_country: 'US',
      } as Order;

      const mockOrderItems = [
        {
          id: 'item-1',
          fourthwall_product_id: 'product-1',
          quantity: 1,
        },
      ] as any;

      mockFetch.mockResolvedValue({
        ok: true,
        text: () => Promise.resolve('Order_Id=KUNAKI123\nStatus=Success'),
      });

      const result = await kunakiService.submitOrder(mockOrder, mockOrderItems);

      expect(result.success).toBe(true);
      expect(result.provider_order_id).toBe('KUNAKI123');
    });

    it('should handle failed order submission', async () => {
      const mockOrder: Order = {
        id: 'order-1',
      } as Order;

      const mockOrderItems = [
        {
          id: 'item-1',
          fourthwall_product_id: 'product-1',
          quantity: 1,
        },
      ] as any;

      mockFetch.mockResolvedValue({
        ok: true,
        text: () => Promise.resolve('Status=Error\nError=Invalid product'),
      });

      const result = await kunakiService.submitOrder(mockOrder, mockOrderItems);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Invalid product');
    });
  });

  describe('checkOrderStatus', () => {
    it('should parse status response correctly', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        text: () => Promise.resolve('Order_Id=KUNAKI123\nStatus=Shipped\nTracking_Number=1Z999AA1234567890'),
      });

      const result = await kunakiService.checkOrderStatus('KUNAKI123');

      expect(result.Order_Id).toBe('KUNAKI123');
      expect(result.Status).toBe('Shipped');
      expect(result.Tracking_Number).toBe('1Z999AA1234567890');
    });

    it('should handle network errors', async () => {
      mockFetch.mockRejectedValue(new Error('Network error'));

      const result = await kunakiService.checkOrderStatus('KUNAKI123');

      expect(result.Status).toBe('Error');
      expect(result.Error).toBe('Network error');
    });
  });
});
