import { WebhookEvent, WebhookSource } from '../types/index.js';
import { BaseRepository } from './base.js';

export class WebhookRepository extends BaseRepository {
  async createWebhookEvent(webhookEvent: Omit<WebhookEvent, 'id' | 'created_at'>): Promise<WebhookEvent> {
    console.log('[WEBHOOK-REPO] Creating webhook event');
    console.log('[WEBHOOK-REPO] Source:', webhookEvent.source);
    console.log('[WEBHOOK-REPO] Event type:', webhookEvent.event_type);
    
    const id = this.generateId();
    const timestamp = this.getCurrentTimestamp();

    const newWebhookEvent: WebhookEvent = {
      ...webhookEvent,
      id,
      created_at: timestamp,
    };

    await this.executeUpdate(
      `INSERT INTO webhook_events (
        id, source, event_type, event_data, processed_at,
        error_message, retry_count, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        newWebhookEvent.id,
        newWebhookEvent.source,
        newWebhookEvent.event_type,
        newWebhookEvent.event_data,
        newWebhookEvent.processed_at,
        newWebhookEvent.error_message,
        newWebhookEvent.retry_count,
        newWebhookEvent.created_at,
      ],
    );

    console.log('[WEBHOOK-REPO] Webhook event created with ID:', newWebhookEvent.id);
    return newWebhookEvent;
  }

  async getWebhookEventById(id: string): Promise<WebhookEvent | null> {
    console.log('[WEBHOOK-REPO] Getting webhook event by ID:', id);
    return await this.executeSingleQuery<WebhookEvent>('SELECT * FROM webhook_events WHERE id = ?', [id]);
  }

  async markWebhookProcessed(id: string): Promise<void> {
    console.log('[WEBHOOK-REPO] Marking webhook as processed:', id);
    await this.executeUpdate('UPDATE webhook_events SET processed_at = ? WHERE id = ?', [
      this.getCurrentTimestamp(),
      id,
    ]);
  }

  async markWebhookError(id: string, errorMessage: string): Promise<void> {
    console.log('[WEBHOOK-REPO] Marking webhook as error:', id);
    console.log('[WEBHOOK-REPO] Error message:', errorMessage);
    await this.executeUpdate(
      'UPDATE webhook_events SET error_message = ?, retry_count = retry_count + 1 WHERE id = ?',
      [errorMessage, id],
    );
  }

  async getUnprocessedWebhooks(source?: WebhookSource): Promise<WebhookEvent[]> {
    console.log('[WEBHOOK-REPO] Getting unprocessed webhooks', source ? `for source: ${source}` : '(all sources)');
    
    let query = 'SELECT * FROM webhook_events WHERE processed_at IS NULL ORDER BY created_at ASC';
    const params: any[] = [];

    if (source) {
      query = 'SELECT * FROM webhook_events WHERE processed_at IS NULL AND source = ? ORDER BY created_at ASC';
      params.push(source);
    }

    const result = await this.executeQuery<WebhookEvent>(query, params);
    const webhooks = result.results || [];
    console.log('[WEBHOOK-REPO] Found', webhooks.length, 'unprocessed webhooks');
    return webhooks;
  }

  async getRetryableWebhooks(maxRetries = 3): Promise<WebhookEvent[]> {
    const result = await this.executeQuery<WebhookEvent>(
      `SELECT * FROM webhook_events 
       WHERE processed_at IS NULL 
       AND error_message IS NOT NULL 
       AND retry_count < ? 
       ORDER BY created_at ASC`,
      [maxRetries],
    );
    return result.results || [];
  }

  async cleanupOldWebhooks(daysOld = 30): Promise<number> {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - daysOld);

    const result = await this.executeUpdate(
      'DELETE FROM webhook_events WHERE created_at < ? AND processed_at IS NOT NULL',
      [cutoffDate.toISOString()],
    );

    return result.meta?.changes || 0;
  }
}
