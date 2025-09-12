import { FulfillmentRepository, OrderRepository, WebhookRepository } from './repositories/index.js';
import { CDClickService, FourthwallService, FulfillmentService } from './services/index.js';
import { CDClickWebhook, Env, FourthwallWebhook, QueueMessage } from './types/index.js';

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

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
          return new Response(
            JSON.stringify({
              status: 'healthy',
              timestamp: new Date().toISOString(),
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
          return await handleFourthwallWebhook(request, env);
        }

        case '/webhook/cdclick': {
          return await handleCDClickWebhook(request, env);
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
      console.error('Error handling request:', error);
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
    for (const message of batch.messages) {
      try {
        await processQueueMessage(message.body, env);
        message.ack();
      } catch (error) {
        console.error('Error processing queue message:', error);
        message.retry();
      }
    }
  },

  async scheduled(_event: ScheduledEvent, env: Env, _ctx: ExecutionContext): Promise<void> {
    const orderRepository = new OrderRepository(env.DB);
    const fulfillmentRepository = new FulfillmentRepository(env.DB);
    const fulfillmentService = new FulfillmentService(env, orderRepository, fulfillmentRepository);

    try {
      console.log('Starting scheduled Kunaki status check');
      await fulfillmentService.processKunakiStatusUpdates();

      console.log('Starting retry of failed orders');
      await fulfillmentService.retryFailedOrders();

      console.log('Scheduled tasks completed');
    } catch (error) {
      console.error('Error in scheduled task:', error);
    }
  },
};

async function handleFourthwallWebhook(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  const signature = request.headers.get('X-Fourthwall-Signature');
  if (!signature) {
    return new Response('Missing signature', { status: 401 });
  }

  const body = await request.text();

  const orderRepository = new OrderRepository(env.DB);
  const webhookRepository = new WebhookRepository(env.DB);
  const fourthwallService = new FourthwallService(env.FOURTHWALL_API_KEY, orderRepository);

  if (!(await fourthwallService.validateWebhookSignature(body, signature, env.WEBHOOK_SECRET))) {
    return new Response('Invalid signature', { status: 401 });
  }

  try {
    const payload: FourthwallWebhook = JSON.parse(body);

    const webhookEvent = await webhookRepository.createWebhookEvent({
      source: 'fourthwall',
      event_type: payload.type,
      event_data: body,
      retry_count: 0,
    });

    await env.WEBHOOK_QUEUE.send({
      type: 'webhook',
      data: {
        webhookId: webhookEvent.id,
        source: 'fourthwall',
        payload,
      },
    });

    return new Response('OK', { status: 200 });
  } catch (error) {
    console.error('Error processing Fourthwall webhook:', error);
    return new Response('Error processing webhook', { status: 500 });
  }
}

async function handleCDClickWebhook(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  const signature = request.headers.get('X-CDClick-Signature');
  if (!signature) {
    return new Response('Missing signature', { status: 401 });
  }

  const body = await request.text();

  const webhookRepository = new WebhookRepository(env.DB);
  const cdclickService = new CDClickService(env.CDCLICK_API_KEY);

  if (!(await cdclickService.validateWebhookSignature(body, signature, env.WEBHOOK_SECRET))) {
    return new Response('Invalid signature', { status: 401 });
  }

  try {
    const payload: CDClickWebhook = JSON.parse(body);

    const webhookEvent = await webhookRepository.createWebhookEvent({
      source: 'cdclick-europe',
      event_type: payload.event_type,
      event_data: body,
      retry_count: 0,
    });

    await env.WEBHOOK_QUEUE.send({
      type: 'webhook',
      data: {
        webhookId: webhookEvent.id,
        source: 'cdclick-europe',
        payload,
      },
    });

    return new Response('OK', { status: 200 });
  } catch (error) {
    console.error('Error processing CDClick webhook:', error);
    return new Response('Error processing webhook', { status: 500 });
  }
}

async function processQueueMessage(message: QueueMessage, env: Env): Promise<void> {
  const orderRepository = new OrderRepository(env.DB);
  const fulfillmentRepository = new FulfillmentRepository(env.DB);
  const webhookRepository = new WebhookRepository(env.DB);

  switch (message.type) {
    case 'webhook': {
      const { webhookId, source, payload } = message.data;

      try {
        if (source === 'fourthwall') {
          const fourthwallService = new FourthwallService(env.FOURTHWALL_API_KEY, orderRepository);
          await fourthwallService.processWebhook(payload);

          // FulfillmentService is used elsewhere but not directly here
          // const fulfillmentService = new FulfillmentService(env, orderRepository, fulfillmentRepository);

          if (payload.type === 'order.paid') {
            const order = await orderRepository.getOrderByFourthwallId(payload.data.attributes.id);
            if (order) {
              await env.FULFILLMENT_QUEUE.send({
                type: 'fulfillment',
                data: { orderId: order.id },
              });
            }
          }
        } else if (source === 'cdclick-europe') {
          const fulfillmentService = new FulfillmentService(env, orderRepository, fulfillmentRepository);
          await fulfillmentService.processCDClickWebhook(payload);
        }

        await webhookRepository.markWebhookProcessed(webhookId);
      } catch (error) {
        console.error(`Error processing webhook ${webhookId}:`, error);
        await webhookRepository.markWebhookError(webhookId, error instanceof Error ? error.message : 'Unknown error');
        throw error;
      }
      break;
    }

    case 'fulfillment': {
      const { orderId } = message.data;
      const fulfillmentService = new FulfillmentService(env, orderRepository, fulfillmentRepository);
      await fulfillmentService.processOrder(orderId);
      break;
    }

    case 'status_check': {
      const fulfillmentService = new FulfillmentService(env, orderRepository, fulfillmentRepository);
      await fulfillmentService.processKunakiStatusUpdates();
      break;
    }

    default: {
      console.warn(`Unknown message type: ${message.type}`);
    }
  }
}
