interface Env {
  VERSION_DB: D1Database;
  VMETRICS_API_TOKEN?: string;
  ENVIRONMENT: string;
  GITHUB_APP_ID?: string;
  GITHUB_APP_PRIVATE_KEY?: string;
  GITHUB_APP_INSTALLATION_ID?: string;
  GITHUB_WEBHOOK_SECRET?: string;
}

declare module 'cloudflare:test' {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  interface ProvidedEnv extends Env {}
}
