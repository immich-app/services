import {
  FulfillmentRepository,
  OrderRepository,
  ProductKeyRepository,
  WebhookRepository,
} from './repositories/index.js';
import {
  EmailService,
  EmailTemplateService,
  FourthwallService,
  FulfillmentService,
  MigrationService,
} from './services/index.js';
import { CDClickWebhook, Env, FourthwallWebhook, ProductKeyEmailData, QueueMessage } from './types/index.js';

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

        case '/cron': {
          console.log(`[FETCH] Manual cron trigger`);
          return await handleCronTrigger(request, env);
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

          try {
            // Get list of applied migrations
            const result = await env.DB.prepare('SELECT * FROM migrations ORDER BY applied_at').all<{
              id: string;
              name: string;
              applied_at: string;
            }>();

            return new Response(
              JSON.stringify({
                initialized: migrationsInitialized,
                applied_migrations: result.results || [],
                total_migrations: await import('./migrations/index.js').then((m) => m.migrations.length),
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
          // CDClick webhook handling is disabled - using cron-based status updates instead
          // if (url.pathname.startsWith('/webhook/cdclick/')) {
          //   console.log(`[FETCH] Handling CDClick webhook with path-based secret`);
          //   return await handleCDClickWebhook(request, env);
          // }

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

      console.log('[SCHEDULED] Starting CDClick status check (max 50 orders)');
      await fulfillmentService.processCDClickStatusUpdates();

      console.log('[SCHEDULED] Starting tracking upload to Fourthwall via CSV');
      await fulfillmentService.uploadTrackingToFourthwall();

      console.log('[SCHEDULED] Starting retry of failed orders');
      // await fulfillmentService.retryFailedOrders();

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
  const fourthwallService = new FourthwallService(
    env.FOURTHWALL_USERNAME,
    env.FOURTHWALL_PASSWORD,
    orderRepository,
    env.FOURTHWALL_USER_USERNAME,
    env.FOURTHWALL_USER_PASSWORD
  );

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

// CDClick webhook handling disabled - using cron-based status updates instead
// eslint-disable-next-line @typescript-eslint/no-unused-vars
async function handleCDClickWebhook(request: Request, env: Env): Promise<Response> {
  console.log('[CD-WEBHOOK] Processing CDClick webhook');

  if (request.method !== 'POST') {
    console.log('[CD-WEBHOOK] Invalid method:', request.method);
    return new Response('Method not allowed', { status: 405 });
  }

  // CDClick doesn't support custom headers, so the secret is passed in the URL path
  // Expected format: /webhook/cdclick/{secret}
  const url = new URL(request.url);
  const pathParts = url.pathname.split('/');
  const secretFromPath = pathParts[3]; // /webhook/cdclick/{secret}

  console.log('[CD-WEBHOOK] Secret in path:', !!secretFromPath);

  if (!secretFromPath) {
    console.log('[CD-WEBHOOK] Missing secret in URL path');
    return new Response('Missing secret in path', { status: 401 });
  }

  if (secretFromPath !== env.WEBHOOK_SECRET) {
    console.log('[CD-WEBHOOK] Invalid secret in path');
    return new Response('Invalid secret', { status: 401 });
  }

  const body = await request.text();
  console.log('[CD-WEBHOOK] Body length:', body.length);
  console.log('[CD-WEBHOOK] Body preview:', body.slice(0, 200));

  const webhookRepository = new WebhookRepository(env.DB);

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

async function handleCronTrigger(request: Request, env: Env): Promise<Response> {
  console.log('[CRON] Manual cron trigger requested');

  if (request.method !== 'POST' && request.method !== 'GET') {
    console.log('[CRON] Invalid method:', request.method);
    return new Response('Method not allowed', { status: 405 });
  }

  try {
    const orderRepository = new OrderRepository(env.DB);
    const fulfillmentRepository = new FulfillmentRepository(env.DB);
    const fulfillmentService = new FulfillmentService(env, orderRepository, fulfillmentRepository);

    console.log('[CRON] Starting Kunaki status check');
    await fulfillmentService.processKunakiStatusUpdates();
    console.log('[CRON] Kunaki status check completed');

    console.log('[CRON] Starting CDClick status check (max 50 orders)');
    await fulfillmentService.processCDClickStatusUpdates();
    console.log('[CRON] CDClick status check completed');

    console.log('[CRON] Starting tracking upload to Fourthwall via CSV');
    await fulfillmentService.uploadTrackingToFourthwall();
    console.log('[CRON] Tracking upload completed');

    return new Response(
      JSON.stringify({
        message: 'Cron tasks completed successfully',
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
    console.error('[CRON] Error in manual cron trigger:', error);
    console.error('[CRON] Error stack:', error instanceof Error ? error.stack : 'No stack');
    return new Response(
      JSON.stringify({
        error: 'Cron task failed',
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
            env.FOURTHWALL_USER_USERNAME,
            env.FOURTHWALL_USER_PASSWORD
          );
          await fourthwallService.processWebhook(payload);
          console.log('[PROCESS-QUEUE] Fourthwall webhook processed successfully');

          // FulfillmentService is used elsewhere but not directly here
          // const fulfillmentService = new FulfillmentService(env, orderRepository, fulfillmentRepository);

          if (payload.type === 'ORDER_PLACED') {
            console.log('[PROCESS-QUEUE] ORDER_PLACED event detected');

            // Check if order status is CONFIRMED before processing
            const orderStatus = payload.data?.status;
            console.log('[PROCESS-QUEUE] Order status:', orderStatus);

            // Handle different order statuses
            switch (orderStatus) {
              case 'CONFIRMED': {
                console.log('[PROCESS-QUEUE] Order CONFIRMED, proceeding with fulfillment');
                break;
              }

              case 'PARTIALLY_IN_PRODUCTION':
              case 'IN_PRODUCTION': {
                console.log(`[PROCESS-QUEUE] Order already in production (${orderStatus}), skipping fulfillment`);
                return;
              }

              case 'PARTIALLY_SHIPPED':
              case 'SHIPPED': {
                console.log(`[PROCESS-QUEUE] Order already shipped (${orderStatus}), skipping fulfillment`);
                return;
              }

              case 'PARTIALLY_DELIVERED':
              case 'DELIVERED':
              case 'COMPLETED': {
                console.log(`[PROCESS-QUEUE] Order already delivered/completed (${orderStatus}), skipping fulfillment`);
                return;
              }

              case 'CANCELLED': {
                console.log('[PROCESS-QUEUE] Order CANCELLED, skipping fulfillment');
                return;
              }

              default: {
                console.log(`[PROCESS-QUEUE] Unknown or pending order status: ${orderStatus}, skipping fulfillment`);
                return;
              }
            }

            // Get order ID from the data field
            const orderId = payload.data?.id;
            if (!orderId) {
              console.log('[PROCESS-QUEUE] No order ID found in webhook data');
              return;
            }

            const order = await orderRepository.getOrderByFourthwallId(orderId);
            if (order) {
              console.log(`[PROCESS-QUEUE] Found CONFIRMED order ${order.id}, queueing for fulfillment`);
              await env.FULFILLMENT_QUEUE.send({
                type: 'fulfillment',
                data: { orderId: order.id },
              });
              console.log(`[PROCESS-QUEUE] Fulfillment queued for order ${order.id}`);
            } else {
              console.log('[PROCESS-QUEUE] No order found for Fourthwall ID:', orderId);
            }
          }
        } else if (source === 'cdclick-europe') {
          console.log('[PROCESS-QUEUE] CDClick webhooks disabled - using cron-based status updates');
          // CDClick webhook processing disabled - using cron-based status updates instead
          // const fulfillmentService = new FulfillmentService(env, orderRepository, fulfillmentRepository);
          // await fulfillmentService.processCDClickWebhook(payload);
          // console.log('[PROCESS-QUEUE] CDClick webhook processed successfully');
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

    case 'product_key_email': {
      const emailData = message.data as ProductKeyEmailData;
      console.log(`[PROCESS-QUEUE] Processing product key email for order ${emailData.orderId}`);

      try {
        const productKeyRepository = new ProductKeyRepository(env.DB);
        const emailService = new EmailService(env);

        // Claim a product key
        const claimedKey = await productKeyRepository.claimProductKey(
          emailData.keyType,
          emailData.orderId,
          emailData.customerEmail,
        );

        if (!claimedKey) {
          console.error(`[PROCESS-QUEUE] No available ${emailData.keyType} keys found`);
          throw new Error(`No available ${emailData.keyType} keys found`);
        }

        console.log(`[PROCESS-QUEUE] Claimed ${emailData.keyType} key:`, claimedKey.key_value);

        // Generate email template
        const emailTemplateData: ProductKeyEmailData = {
          ...emailData,
          keyValue: claimedKey.key_value,
          activationKey: claimedKey.activation_key,
        };

        const { html, text, subject } = EmailTemplateService.generateProductKeyEmail(emailTemplateData);

        // Send the email
        await emailService.sendEmail({
          to: emailData.customerEmail,
          subject,
          html,
          text,
        });

        // Mark the key as sent
        await productKeyRepository.markKeySent(claimedKey.key_value);

        console.log(`[PROCESS-QUEUE] Product key email sent successfully for order ${emailData.orderId}`);
      } catch (error) {
        console.error(`[PROCESS-QUEUE] Error processing product key email:`, error);
        throw error;
      }
      break;
    }

    default: {
      console.warn(`[PROCESS-QUEUE] Unknown message type: ${message.type}`);
      console.warn(`[PROCESS-QUEUE] Full message:`, JSON.stringify(message));
    }
  }
}
