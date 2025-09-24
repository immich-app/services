import { FulfillmentRepository, OrderRepository, WebhookRepository } from './repositories/index.js';
import { CDClickService, FourthwallService, FulfillmentService, MigrationService } from './services/index.js';
import { CDClickWebhook, Env, FourthwallWebhook, QueueMessage } from './types/index.js';

// Track if migrations have been run in this worker instance
let migrationsInitialized = false;

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    console.log(`[FETCH] Incoming request: ${request.method} ${url.pathname}`);
    console.log(`[FETCH] Headers:`, Object.fromEntries(request.headers.entries()));

    // Run migrations on first request if not already done
    if (!migrationsInitialized) {
      console.log('[FETCH] Running database migrations on first request');
      const migrationService = new MigrationService(env.DB);
      await migrationService.runMigrations();
      migrationsInitialized = true;
    }

    try {
      switch (url.pathname) {
        case '/': {
          return new Response(
            JSON.stringify({
              message: 'Fourthwall Integration API',
              timestamp: new Date().toISOString(),
              path: url.pathname,
            }),
            {
              headers: {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*',
              },
            },
          );
        }

        case '/health': {
          // Check if migrations are needed
          const migrationService = new MigrationService(env.DB);
          const needsMigration = await migrationService.needsMigration();
          
          return new Response(
            JSON.stringify({
              status: 'healthy',
              timestamp: new Date().toISOString(),
              database: {
                migrations_initialized: migrationsInitialized,
                needs_migration: needsMigration,
              },
            }),
            {
              headers: {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*',
              },
            },
          );
        }

        case '/webhook/fourthwall': {
          console.log(`[FETCH] Handling Fourthwall webhook`);
          return await handleFourthwallWebhook(request, env);
        }

        case '/webhook/cdclick': {
          console.log(`[FETCH] Handling CDClick webhook`);
          return await handleCDClickWebhook(request, env);
        }

        case '/admin/migrations': {
          // Admin endpoint to check migration status or run migrations
          if (request.method === 'POST') {
            // Manual trigger to run migrations
            console.log('[ADMIN] Manual migration trigger');
            const migrationService = new MigrationService(env.DB);
            await migrationService.runMigrations();
            migrationsInitialized = true;
            
            return new Response(
              JSON.stringify({
                message: 'Migrations executed',
                timestamp: new Date().toISOString(),
              }),
              {
                status: 200,
                headers: {
                  'Content-Type': 'application/json',
                  'Access-Control-Allow-Origin': '*',
                },
              },
            );
          }
          
          if (request.method !== 'GET') {
            return new Response('Method not allowed', { status: 405 });
          }

          const migrationService = new MigrationService(env.DB);
          
          try {
            // Get list of applied migrations
            const result = await env.DB
              .prepare('SELECT * FROM migrations ORDER BY applied_at')
              .all<{ id: string; name: string; applied_at: string }>();

            return new Response(
              JSON.stringify({
                initialized: migrationsInitialized,
                applied_migrations: result.results || [],
                total_migrations: (await import('./migrations/index.js')).migrations.length,
                timestamp: new Date().toISOString(),
              }),
              {
                status: 200,
                headers: {
                  'Content-Type': 'application/json',
                  'Access-Control-Allow-Origin': '*',
                },
              },
            );
          } catch (error) {
            return new Response(
              JSON.stringify({
                error: 'Failed to get migration status',
                message: error instanceof Error ? error.message : 'Unknown error',
              }),
              {
                status: 500,
                headers: {
                  'Content-Type': 'application/json',
                  'Access-Control-Allow-Origin': '*',
                },
              },
            );
          }
        }

        default: {
          return new Response(
            JSON.stringify({
              error: 'Not Found',
              path: url.pathname,
            }),
            {
              status: 404,
              headers: {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*',
              },
            },
          );
        }
      }
    } catch (error) {
      console.error('[FETCH] Error handling request:', error);
      console.error('[FETCH] Error stack:', error instanceof Error ? error.stack : 'No stack');
      return new Response(
        JSON.stringify({
          error: 'Internal Server Error',
          message: error instanceof Error ? error.message : 'Unknown error',
        }),
        {
          status: 500,
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
          },
        },
      );
    }
  },

  async queue(batch: MessageBatch<QueueMessage>, env: Env, _ctx: ExecutionContext): Promise<void> {
    console.log(`[QUEUE] Processing batch of ${batch.messages.length} messages`);
    for (const message of batch.messages) {
      try {
        console.log(`[QUEUE] Processing message:`, JSON.stringify(message.body));
        await processQueueMessage(message.body, env);
        message.ack();
        console.log(`[QUEUE] Message acknowledged successfully`);
      } catch (error) {
        console.error('[QUEUE] Error processing message:', error);
        console.error('[QUEUE] Error stack:', error instanceof Error ? error.stack : 'No stack');
        message.retry();
      }
    }
  },

  async scheduled(_event: ScheduledEvent, env: Env, _ctx: ExecutionContext): Promise<void> {
    console.log('[SCHEDULED] Cron job started at:', new Date().toISOString());
    const orderRepository = new OrderRepository(env.DB);
    const fulfillmentRepository = new FulfillmentRepository(env.DB);
    const fulfillmentService = new FulfillmentService(env, orderRepository, fulfillmentRepository);

    try {
      console.log('[SCHEDULED] Starting Kunaki status check');
      await fulfillmentService.processKunakiStatusUpdates();

      console.log('[SCHEDULED] Starting retry of failed orders');
      await fulfillmentService.retryFailedOrders();

      console.log('[SCHEDULED] All tasks completed successfully');
    } catch (error) {
      console.error('[SCHEDULED] Error in scheduled task:', error);
      console.error('[SCHEDULED] Error stack:', error instanceof Error ? error.stack : 'No stack');
    }
  },
};

async function handleFourthwallWebhook(request: Request, env: Env): Promise<Response> {
  console.log('[FW-WEBHOOK] Processing Fourthwall webhook');

  if (request.method !== 'POST') {
    console.log('[FW-WEBHOOK] Invalid method:', request.method);
    return new Response('Method not allowed', { status: 405 });
  }

  const signature = request.headers.get('X-Fourthwall-Hmac-SHA256');
  console.log('[FW-WEBHOOK] Signature present:', !!signature);
  if (!signature) {
    console.log('[FW-WEBHOOK] Missing signature header (X-Fourthwall-Hmac-SHA256)');
    return new Response('Missing signature', { status: 401 });
  }

  const body = await request.text();
  console.log('[FW-WEBHOOK] Body length:', body.length);
  console.log('[FW-WEBHOOK] Body preview:', body.slice(0, 200));

  const orderRepository = new OrderRepository(env.DB);
  const webhookRepository = new WebhookRepository(env.DB);
  const fourthwallService = new FourthwallService(env.FOURTHWALL_USERNAME, env.FOURTHWALL_PASSWORD, orderRepository);

  const isValidSignature = await fourthwallService.validateWebhookSignature(body, signature, env.WEBHOOK_SECRET);
  console.log('[FW-WEBHOOK] Signature validation result:', isValidSignature);
  if (!isValidSignature) {
    console.log('[FW-WEBHOOK] Invalid signature, rejecting');
    return new Response('Invalid signature', { status: 401 });
  }

  try {
    const payload: FourthwallWebhook = JSON.parse(body);
    console.log('[FW-WEBHOOK] Parsed payload type:', payload.type);
    console.log('[FW-WEBHOOK] Webhook ID:', payload.id);
    console.log('[FW-WEBHOOK] Shop ID:', payload.shopId);
    console.log('[FW-WEBHOOK] API Version:', payload.apiVersion);
    console.log('[FW-WEBHOOK] Has data:', !!payload.data);

    const webhookEvent = await webhookRepository.createWebhookEvent({
      source: 'fourthwall',
      event_type: payload.type,
      event_data: body,
      retry_count: 0,
    });
    console.log('[FW-WEBHOOK] Created webhook event with ID:', webhookEvent.id);

    console.log('[FW-WEBHOOK] Sending message to queue');
    await env.WEBHOOK_QUEUE.send({
      type: 'webhook',
      data: {
        webhookId: webhookEvent.id,
        source: 'fourthwall',
        payload,
      },
    });

    console.log('[FW-WEBHOOK] Successfully queued webhook for processing');
    return new Response('OK', { status: 200 });
  } catch (error) {
    console.error('[FW-WEBHOOK] Error processing webhook:', error);
    console.error('[FW-WEBHOOK] Error stack:', error instanceof Error ? error.stack : 'No stack');
    return new Response('Error processing webhook', { status: 500 });
  }
}

async function handleCDClickWebhook(request: Request, env: Env): Promise<Response> {
  console.log('[CD-WEBHOOK] Processing CDClick webhook');

  if (request.method !== 'POST') {
    console.log('[CD-WEBHOOK] Invalid method:', request.method);
    return new Response('Method not allowed', { status: 405 });
  }

  const signature = request.headers.get('X-CDClick-Signature');
  console.log('[CD-WEBHOOK] Signature present:', !!signature);
  if (!signature) {
    console.log('[CD-WEBHOOK] Missing signature header');
    return new Response('Missing signature', { status: 401 });
  }

  const body = await request.text();
  console.log('[CD-WEBHOOK] Body length:', body.length);
  console.log('[CD-WEBHOOK] Body preview:', body.slice(0, 200));

  const webhookRepository = new WebhookRepository(env.DB);
  const cdclickService = new CDClickService(env.CDCLICK_API_KEY);

  const isValidSignature = await cdclickService.validateWebhookSignature(body, signature, env.WEBHOOK_SECRET);
  console.log('[CD-WEBHOOK] Signature validation result:', isValidSignature);
  if (!isValidSignature) {
    console.log('[CD-WEBHOOK] Invalid signature, rejecting');
    return new Response('Invalid signature', { status: 401 });
  }

  try {
    const payload: CDClickWebhook = JSON.parse(body);
    console.log('[CD-WEBHOOK] Parsed payload type:', payload.event_type);
    console.log('[CD-WEBHOOK] Order ID:', payload.order_id);

    const webhookEvent = await webhookRepository.createWebhookEvent({
      source: 'cdclick-europe',
      event_type: payload.event_type,
      event_data: body,
      retry_count: 0,
    });
    console.log('[CD-WEBHOOK] Created webhook event with ID:', webhookEvent.id);

    console.log('[CD-WEBHOOK] Sending message to queue');
    await env.WEBHOOK_QUEUE.send({
      type: 'webhook',
      data: {
        webhookId: webhookEvent.id,
        source: 'cdclick-europe',
        payload,
      },
    });

    console.log('[CD-WEBHOOK] Successfully queued webhook for processing');
    return new Response('OK', { status: 200 });
  } catch (error) {
    console.error('[CD-WEBHOOK] Error processing webhook:', error);
    console.error('[CD-WEBHOOK] Error stack:', error instanceof Error ? error.stack : 'No stack');
    return new Response('Error processing webhook', { status: 500 });
  }
}

async function processQueueMessage(message: QueueMessage, env: Env): Promise<void> {
  console.log('[PROCESS-QUEUE] Processing message type:', message.type);
  console.log('[PROCESS-QUEUE] Message data:', JSON.stringify(message.data));

  const orderRepository = new OrderRepository(env.DB);
  const fulfillmentRepository = new FulfillmentRepository(env.DB);
  const webhookRepository = new WebhookRepository(env.DB);

  switch (message.type) {
    case 'webhook': {
      const { webhookId, source, payload } = message.data;
      console.log(`[PROCESS-QUEUE] Processing webhook: ID=${webhookId}, Source=${source}`);

      try {
        if (source === 'fourthwall') {
          console.log('[PROCESS-QUEUE] Processing Fourthwall webhook payload');
          const fourthwallService = new FourthwallService(
            env.FOURTHWALL_USERNAME,
            env.FOURTHWALL_PASSWORD,
            orderRepository,
          );
          await fourthwallService.processWebhook(payload);
          console.log('[PROCESS-QUEUE] Fourthwall webhook processed successfully');

          // FulfillmentService is used elsewhere but not directly here
          // const fulfillmentService = new FulfillmentService(env, orderRepository, fulfillmentRepository);

          if (payload.type === 'ORDER_PLACED') {
            console.log('[PROCESS-QUEUE] ORDER_PLACED event detected, checking for order');
            // Get order ID from the data field
            const orderId = payload.data?.id;
            if (!orderId) {
              console.log('[PROCESS-QUEUE] No order ID found in webhook data');
              return;
            }
            const order = await orderRepository.getOrderByFourthwallId(orderId);
            if (order) {
              console.log(`[PROCESS-QUEUE] Found order ${order.id}, queueing for fulfillment`);
              await env.FULFILLMENT_QUEUE.send({
                type: 'fulfillment',
                data: { orderId: order.id },
              });
              console.log(`[PROCESS-QUEUE] Fulfillment queued for order ${order.id}`);
            } else {
              console.log('[PROCESS-QUEUE] No order found for Fourthwall ID:', payload.data.attributes.id);
            }
          }
        } else if (source === 'cdclick-europe') {
          console.log('[PROCESS-QUEUE] Processing CDClick webhook payload');
          const fulfillmentService = new FulfillmentService(env, orderRepository, fulfillmentRepository);
          await fulfillmentService.processCDClickWebhook(payload);
          console.log('[PROCESS-QUEUE] CDClick webhook processed successfully');
        }

        console.log(`[PROCESS-QUEUE] Marking webhook ${webhookId} as processed`);
        await webhookRepository.markWebhookProcessed(webhookId);
        console.log(`[PROCESS-QUEUE] Webhook ${webhookId} marked as processed`);
      } catch (error) {
        console.error(`[PROCESS-QUEUE] Error processing webhook ${webhookId}:`, error);
        console.error('[PROCESS-QUEUE] Error stack:', error instanceof Error ? error.stack : 'No stack');
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        console.log(`[PROCESS-QUEUE] Marking webhook ${webhookId} as error:`, errorMessage);
        await webhookRepository.markWebhookError(webhookId, errorMessage);
        throw error;
      }
      break;
    }

    case 'fulfillment': {
      const { orderId } = message.data;
      console.log(`[PROCESS-QUEUE] Processing fulfillment for order ${orderId}`);
      const fulfillmentService = new FulfillmentService(env, orderRepository, fulfillmentRepository);
      await fulfillmentService.processOrder(orderId);
      console.log(`[PROCESS-QUEUE] Fulfillment processing complete for order ${orderId}`);
      break;
    }

    case 'status_check': {
      console.log('[PROCESS-QUEUE] Processing status check');
      const fulfillmentService = new FulfillmentService(env, orderRepository, fulfillmentRepository);
      await fulfillmentService.processKunakiStatusUpdates();
      console.log('[PROCESS-QUEUE] Status check complete');
      break;
    }

    default: {
      console.warn(`[PROCESS-QUEUE] Unknown message type: ${message.type}`);
      console.warn(`[PROCESS-QUEUE] Full message:`, JSON.stringify(message));
    }
  }
}
