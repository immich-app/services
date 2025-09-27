import { ProductKey, ProductKeyType } from '../types/index.js';
import { BaseRepository } from './base.js';

export class ProductKeyRepository extends BaseRepository {
  async createProductKey(keyType: ProductKeyType, keyValue: string): Promise<ProductKey> {
    console.log('[PRODUCT-KEY-REPO] Creating new product key');
    console.log('[PRODUCT-KEY-REPO] Key type:', keyType);
    console.log('[PRODUCT-KEY-REPO] Key value:', keyValue);

    const timestamp = this.getCurrentTimestamp();

    const newKey: ProductKey = {
      key_value: keyValue,
      key_type: keyType,
      is_claimed: false,
      created_at: timestamp,
    };

    await this.executeUpdate(
      `INSERT INTO product_keys (
        key_value, key_type, is_claimed, created_at
      ) VALUES (?, ?, ?, ?)`,
      [newKey.key_value, newKey.key_type, newKey.is_claimed, newKey.created_at],
    );

    console.log('[PRODUCT-KEY-REPO] Product key created successfully with key:', newKey.key_value);
    return newKey;
  }

  async claimProductKey(keyType: ProductKeyType, orderId: string, customerEmail: string): Promise<ProductKey | null> {
    console.log('[PRODUCT-KEY-REPO] Claiming product key');
    console.log('[PRODUCT-KEY-REPO] Key type:', keyType);
    console.log('[PRODUCT-KEY-REPO] Order ID:', orderId);
    console.log('[PRODUCT-KEY-REPO] Customer email:', customerEmail);

    // First, find an available key
    const availableKey = await this.executeSingleQuery<ProductKey>(
      `SELECT * FROM product_keys 
       WHERE key_type = ? AND is_claimed = FALSE 
       ORDER BY created_at ASC 
       LIMIT 1`,
      [keyType],
    );

    if (!availableKey) {
      console.log('[PRODUCT-KEY-REPO] No available keys found for type:', keyType);
      return null;
    }

    console.log('[PRODUCT-KEY-REPO] Found available key:', availableKey.key_value);

    // Claim the key
    const claimedAt = this.getCurrentTimestamp();
    await this.executeUpdate(
      `UPDATE product_keys 
       SET is_claimed = TRUE, claimed_at = ?, order_id = ?, customer_email = ?
       WHERE key_value = ?`,
      [claimedAt, orderId, customerEmail, availableKey.key_value],
    );

    console.log('[PRODUCT-KEY-REPO] Key claimed successfully');

    // Return the updated key
    const claimedKey: ProductKey = {
      ...availableKey,
      is_claimed: true,
      claimed_at: claimedAt,
      order_id: orderId,
      customer_email: customerEmail,
    };

    return claimedKey;
  }

  async markKeySent(keyValue: string): Promise<void> {
    console.log('[PRODUCT-KEY-REPO] Marking key as sent:', keyValue);

    const sentAt = this.getCurrentTimestamp();
    await this.executeUpdate(`UPDATE product_keys SET sent_at = ? WHERE key_value = ?`, [sentAt, keyValue]);

    console.log('[PRODUCT-KEY-REPO] Key marked as sent successfully');
  }

  async getProductKeyByValue(keyValue: string): Promise<ProductKey | null> {
    console.log('[PRODUCT-KEY-REPO] Getting product key by value:', keyValue);

    const key = await this.executeSingleQuery<ProductKey>(`SELECT * FROM product_keys WHERE key_value = ?`, [keyValue]);

    console.log('[PRODUCT-KEY-REPO] Found key:', !!key);
    return key;
  }

  async getProductKeysByOrder(orderId: string): Promise<ProductKey[]> {
    console.log('[PRODUCT-KEY-REPO] Getting product keys for order:', orderId);

    const result = await this.executeQuery<ProductKey>(
      `SELECT * FROM product_keys WHERE order_id = ? ORDER BY claimed_at DESC`,
      [orderId],
    );

    console.log('[PRODUCT-KEY-REPO] Found', result.results?.length || 0, 'keys for order');
    return result.results || [];
  }

  async getProductKeysByCustomerEmail(customerEmail: string): Promise<ProductKey[]> {
    console.log('[PRODUCT-KEY-REPO] Getting product keys for customer:', customerEmail);

    const result = await this.executeQuery<ProductKey>(
      `SELECT * FROM product_keys WHERE customer_email = ? ORDER BY claimed_at DESC`,
      [customerEmail],
    );

    console.log('[PRODUCT-KEY-REPO] Found', result.results?.length || 0, 'keys for customer');
    return result.results || [];
  }

  async getAvailableKeysCount(keyType: ProductKeyType): Promise<number> {
    console.log('[PRODUCT-KEY-REPO] Getting available keys count for type:', keyType);

    const result = await this.executeSingleQuery<{ count: number }>(
      `SELECT COUNT(*) as count FROM product_keys WHERE key_type = ? AND is_claimed = FALSE`,
      [keyType],
    );

    const count = result?.count || 0;
    console.log('[PRODUCT-KEY-REPO] Available keys count:', count);
    return count;
  }

  async getAllProductKeys(keyType?: ProductKeyType, limit = 100, offset = 0): Promise<ProductKey[]> {
    console.log('[PRODUCT-KEY-REPO] Getting all product keys');
    console.log('[PRODUCT-KEY-REPO] Key type filter:', keyType);
    console.log('[PRODUCT-KEY-REPO] Limit:', limit, 'Offset:', offset);

    let query = `SELECT * FROM product_keys`;
    const params: any[] = [];

    if (keyType) {
      query += ` WHERE key_type = ?`;
      params.push(keyType);
    }

    query += ` ORDER BY created_at DESC LIMIT ? OFFSET ?`;
    params.push(limit, offset);

    const result = await this.executeQuery<ProductKey>(query, params);

    console.log('[PRODUCT-KEY-REPO] Found', result.results?.length || 0, 'keys');
    return result.results || [];
  }

  async bulkCreateProductKeys(keyType: ProductKeyType, keyValues: string[]): Promise<ProductKey[]> {
    console.log('[PRODUCT-KEY-REPO] Bulk creating product keys');
    console.log('[PRODUCT-KEY-REPO] Key type:', keyType);
    console.log('[PRODUCT-KEY-REPO] Number of keys:', keyValues.length);

    const createdKeys: ProductKey[] = [];
    const timestamp = this.getCurrentTimestamp();

    // Create keys in batches to avoid overwhelming the database
    const batchSize = 50;
    for (let i = 0; i < keyValues.length; i += batchSize) {
      const batch = keyValues.slice(i, i + batchSize);

      for (const keyValue of batch) {
        const newKey: ProductKey = {
          key_value: keyValue,
          key_type: keyType,
          is_claimed: false,
          created_at: timestamp,
        };

        await this.executeUpdate(
          `INSERT INTO product_keys (
            key_value, key_type, is_claimed, created_at
          ) VALUES (?, ?, ?, ?)`,
          [newKey.key_value, newKey.key_type, newKey.is_claimed, newKey.created_at],
        );

        createdKeys.push(newKey);
      }
    }

    console.log('[PRODUCT-KEY-REPO] Bulk created', createdKeys.length, 'product keys');
    return createdKeys;
  }
}
