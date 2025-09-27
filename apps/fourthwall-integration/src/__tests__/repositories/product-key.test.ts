import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ProductKeyRepository } from '../../repositories/product-key.js';
import { ProductKey, ProductKeyType } from '../../types/index.js';

describe('ProductKeyRepository', () => {
  let productKeyRepository: ProductKeyRepository;
  let mockDB: any;

  beforeEach(() => {
    vi.clearAllMocks();
    mockDB = {
      prepare: vi.fn(() => ({
        bind: vi.fn().mockReturnThis(),
        all: vi.fn(),
        first: vi.fn(),
        run: vi.fn(),
      })),
    };
    productKeyRepository = new ProductKeyRepository(mockDB as D1Database);
  });

  describe('createProductKey', () => {
    it('should create a new product key', async () => {
      const keyType: ProductKeyType = 'client';
      const keyValue = 'test-key-123';

      const mockChain = {
        bind: vi.fn().mockReturnThis(),
        run: vi.fn().mockResolvedValue({ success: true }),
      };
      mockDB.prepare.mockReturnValue(mockChain);

      const result = await productKeyRepository.createProductKey(keyType, keyValue);

      expect(result).toMatchObject({
        key_value: keyValue,
        key_type: keyType,
        is_claimed: false,
      });
      expect(result.created_at).toBeDefined();
    });
  });

  describe('claimProductKey', () => {
    it('should claim an available product key', async () => {
      const keyType: ProductKeyType = 'server';
      const orderId = 'order-123';
      const customerEmail = 'test@example.com';

      const availableKey: ProductKey = {
        key_value: 'test-key-value',
        key_type: keyType,
        is_claimed: false,
        created_at: '2024-01-01T00:00:00Z',
      };

      const mockChain = {
        bind: vi.fn().mockReturnThis(),
        first: vi.fn().mockResolvedValue(availableKey),
        run: vi.fn().mockResolvedValue({ success: true }),
      };
      mockDB.prepare.mockReturnValue(mockChain);

      const result = await productKeyRepository.claimProductKey(keyType, orderId, customerEmail);

      expect(result).toMatchObject({
        ...availableKey,
        is_claimed: true,
        order_id: orderId,
        customer_email: customerEmail,
      });
      expect(result?.claimed_at).toBeDefined();
    });

    it('should return null when no keys are available', async () => {
      const keyType: ProductKeyType = 'client';
      const orderId = 'order-123';
      const customerEmail = 'test@example.com';

      const mockChain = {
        bind: vi.fn().mockReturnThis(),
        first: vi.fn().mockResolvedValue(null),
      };
      mockDB.prepare.mockReturnValue(mockChain);

      const result = await productKeyRepository.claimProductKey(keyType, orderId, customerEmail);

      expect(result).toBeNull();
    });
  });

  describe('markKeySent', () => {
    it('should mark a key as sent', async () => {
      const keyValue = 'test-key-123';

      const mockChain = {
        bind: vi.fn().mockReturnThis(),
        run: vi.fn().mockResolvedValue({ success: true }),
      };
      mockDB.prepare.mockReturnValue(mockChain);

      await productKeyRepository.markKeySent(keyValue);

      expect(mockDB.prepare).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE product_keys SET sent_at = ? WHERE key_value = ?'),
      );
    });
  });

  describe('getAvailableKeysCount', () => {
    it('should return the count of available keys', async () => {
      const keyType: ProductKeyType = 'client';
      const mockCount = { count: 5 };

      const mockChain = {
        bind: vi.fn().mockReturnThis(),
        first: vi.fn().mockResolvedValue(mockCount),
      };
      mockDB.prepare.mockReturnValue(mockChain);

      const result = await productKeyRepository.getAvailableKeysCount(keyType);

      expect(result).toBe(5);
    });

    it('should return 0 when no count result', async () => {
      const keyType: ProductKeyType = 'server';

      const mockChain = {
        bind: vi.fn().mockReturnThis(),
        first: vi.fn().mockResolvedValue(null),
      };
      mockDB.prepare.mockReturnValue(mockChain);

      const result = await productKeyRepository.getAvailableKeysCount(keyType);

      expect(result).toBe(0);
    });
  });

  describe('getProductKeysByOrder', () => {
    it('should return keys for a specific order', async () => {
      const orderId = 'order-123';
      const mockKeys: ProductKey[] = [
        {
          key_value: 'test-key-1',
          key_type: 'client',
          is_claimed: true,
          order_id: orderId,
          customer_email: 'test@example.com',
          claimed_at: '2024-01-01T00:00:00Z',
          created_at: '2024-01-01T00:00:00Z',
        },
      ];

      const mockChain = {
        bind: vi.fn().mockReturnThis(),
        all: vi.fn().mockResolvedValue({ results: mockKeys }),
      };
      mockDB.prepare.mockReturnValue(mockChain);

      const result = await productKeyRepository.getProductKeysByOrder(orderId);

      expect(result).toEqual(mockKeys);
    });
  });

  describe('bulkCreateProductKeys', () => {
    it('should create multiple product keys', async () => {
      const keyType: ProductKeyType = 'client';
      const keyValues = ['key-1', 'key-2', 'key-3'];

      const mockChain = {
        bind: vi.fn().mockReturnThis(),
        run: vi.fn().mockResolvedValue({ success: true }),
      };
      mockDB.prepare.mockReturnValue(mockChain);

      const result = await productKeyRepository.bulkCreateProductKeys(keyType, keyValues);

      expect(result).toHaveLength(3);
      expect(result[0]).toMatchObject({
        key_value: 'key-1',
        key_type: keyType,
        is_claimed: false,
      });
      expect(result[1]).toMatchObject({
        key_value: 'key-2',
        key_type: keyType,
        is_claimed: false,
      });
      expect(result[2]).toMatchObject({
        key_value: 'key-3',
        key_type: keyType,
        is_claimed: false,
      });
    });
  });
});
