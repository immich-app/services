# Fourthwall Integration Helper

This document provides detailed guidance for working with the Fourthwall integration worker.

## Quick Reference

### Common Tasks

#### Adding a New Fulfillment Provider

1. Create service class in `src/services/new-provider.ts`:
```typescript
export class NewProviderService {
  constructor(private apiKey: string) {}
  
  async createOrder(order: Order, items: OrderItem[]): Promise<FulfillmentResult> {
    // Implementation
  }
  
  async getOrderStatus(providerOrderId: string): Promise<FulfillmentStatus> {
    // Implementation
  }
}
```

2. Update `src/types/index.ts`:
```typescript
export type FulfillmentProvider = 'kunaki' | 'cdclick-europe' | 'new-provider';
```

3. Add to `src/services/fulfillment.ts` routing logic
4. Update environment types in `worker-configuration.d.ts`
5. Add test coverage in `src/__tests__/services/`

#### Handling New Webhook Events

1. Add event type to `src/types/index.ts`
2. Update webhook handler in `src/index.ts:handleFourthwallWebhook()`
3. Add processing logic in `src/services/fourthwall.ts:processWebhook()`
4. Update queue message handler if needed

#### Database Schema Changes

1. Create migration file in deployment
2. Update repository classes in `src/repositories/`
3. Update TypeScript interfaces in `src/types/`
4. Run migration before deploying

### API Integration Details

#### Fourthwall API

- **Authentication**: Basic Auth with username and password
- **Webhook Signature**: HMAC-SHA256 in `X-Fourthwall-Signature`
- **Order Events**: `order.paid`, `order.cancelled`, `order.refunded`
- **Rate Limits**: 1000 requests/hour
- **API Docs**: https://docs.fourthwall.com/open-api/

#### Kunaki API (US Fulfillment)

- **Base URL**: `https://www.kunaki.com/XMLService.ASP`
- **Authentication**: Basic auth with username/password
- **XML Format**: Custom XML structure (see `src/services/kunaki.ts`)
- **Status Codes**: `Manufactured`, `Shipped`, `Processing`
- **Polling**: Check status every 15 minutes via cron

#### CDClick Europe API

- **Base URL**: `https://api.cdclick.eu/v1`
- **Authentication**: Bearer token in header
- **Format**: JSON REST API
- **Webhook Events**: `order.shipped`, `order.delivered`
- **Country Coverage**: EU countries

### Testing

#### Unit Tests

```bash
# Test specific service
pnpm run test src/services/kunaki.test.ts

# Test with coverage
pnpm run test --coverage

# Test in watch mode
pnpm run test --watch
```

#### Integration Testing

1. Set up test environment variables in `.dev.vars`
2. Use Miniflare for local worker simulation
3. Mock external APIs using MSW or similar

#### Manual Testing

```bash
# Test webhook locally
curl -X POST http://localhost:8787/webhook/fourthwall \
  -H "Content-Type: application/json" \
  -H "X-Fourthwall-Signature: test-signature" \
  -d '{"type":"order.paid","data":{"id":"123"}}'

# Test health endpoint
curl http://localhost:8787/health
```

### Queue Processing

#### Message Types

1. **webhook**: Initial webhook processing
   - Validates and stores webhook
   - Triggers order processing for paid orders

2. **fulfillment**: Order fulfillment
   - Routes to appropriate provider
   - Creates fulfillment records
   - Handles errors and retries

3. **status_check**: Status updates
   - Polls Kunaki for shipping updates
   - Updates order status in database
   - Notifies Fourthwall of fulfillment

#### Queue Configuration

```toml
# wrangler.toml
[[queues.producers]]
queue = "webhook-processor"
binding = "WEBHOOK_QUEUE"

[[queues.producers]]
queue = "fulfillment-processor"
binding = "FULFILLMENT_QUEUE"
```

### Monitoring & Debugging

#### Logs

```bash
# View live logs
wrangler tail

# View logs with filter
wrangler tail --format pretty | grep ERROR
```

#### Common Issues

1. **Webhook Signature Validation Fails**
   - Check WEBHOOK_SECRET matches Fourthwall dashboard
   - Ensure raw body is used for signature validation

2. **Fulfillment Provider Timeout**
   - Implement retry logic with exponential backoff
   - Check provider API status page

3. **Queue Message Processing Fails**
   - Check message.retry() is called on errors
   - Monitor retry_count to avoid infinite loops

4. **Database Connection Issues**
   - Ensure D1 database is properly bound
   - Check migration status

### Deployment Checklist

- [ ] Run tests: `pnpm run test`
- [ ] Type check: `pnpm run check`
- [ ] Update environment variables in Cloudflare dashboard
- [ ] Run database migrations if needed
- [ ] Deploy: `pnpm run deploy`
- [ ] Verify webhook endpoints are accessible
- [ ] Test with a small order in staging
- [ ] Monitor logs for first 30 minutes

### Performance Optimization

1. **Batch Processing**: Process multiple orders in parallel when possible
2. **Caching**: Cache provider API responses where appropriate
3. **Queue Batching**: Use batch size optimization for queue processing
4. **Database Queries**: Use indexes and optimize query patterns
5. **Error Handling**: Fail fast for non-retryable errors

### Security Considerations

1. **API Keys**: Never commit secrets, use wrangler secrets
2. **Webhook Validation**: Always validate signatures before processing
3. **Input Validation**: Sanitize all external inputs
4. **Rate Limiting**: Implement rate limiting for public endpoints
5. **CORS**: Configure appropriate CORS headers

## Troubleshooting Guide

### Order Not Processing

1. Check webhook was received: Query `webhook_events` table
2. Verify order status in `orders` table
3. Check queue messages for errors
4. Review logs for specific order ID

### Status Not Updating

1. Verify cron job is running (check scheduled handler logs)
2. Check Kunaki API credentials are valid
3. Look for errors in `fulfillment_orders` table
4. Manually trigger status check if needed

### Provider Integration Issues

1. Test provider API directly with curl
2. Check API key/credentials are correct
3. Verify request format matches provider documentation
4. Check for provider-specific error codes

## Contact & Resources

- **Fourthwall API Docs**: [Link to documentation]
- **Kunaki Support**: [Contact information]
- **CDClick Europe API**: [API documentation]
- **Internal Team**: [Slack channel or contact]