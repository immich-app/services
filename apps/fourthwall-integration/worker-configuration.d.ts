interface Env {
  DB: D1Database;
  WEBHOOK_QUEUE: Queue;
  FULFILLMENT_QUEUE: Queue;
  FOURTHWALL_USERNAME: string;
  FOURTHWALL_PASSWORD: string;
  KUNAKI_API_USERNAME: string;
  KUNAKI_API_PASSWORD: string;
  CDCLICK_API_KEY: string;
  WEBHOOK_SECRET: string;
  ENVIRONMENT?: string;
}
