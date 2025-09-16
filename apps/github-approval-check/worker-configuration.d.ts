interface Env {
  // GitHub App configuration
  GITHUB_APP_ID: string;
  GITHUB_APP_PRIVATE_KEY: string;
  
  // Organization webhook secret
  GITHUB_WEBHOOK_SECRET: string;
  
  // Approval configuration  
  ALLOWED_USERS_URL: string;
}

// Type declaration for cloudflare:test module
declare module 'cloudflare:test' {
  export const SELF: {
    fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  };
}