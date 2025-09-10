interface Env {
  // Environment variables
  GITHUB_APP_ID: string;
  ALLOWED_USERS_URL: string;

  // Secrets
  GITHUB_APP_PRIVATE_KEY: string;
  GITHUB_WEBHOOK_SECRET: string;
}

// Type declaration for cloudflare:test module
declare module 'cloudflare:test' {
  export const SELF: {
    fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  };
}