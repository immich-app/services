interface Env {
  DISCORD_BOT: DurableObjectNamespace;

  // Discord
  BOT_TOKEN: string;

  // GitHub
  GITHUB_SLUG: string;
  GITHUB_STATUS_SLUG: string;
  GITHUB_APP_ID: string;
  GITHUB_INSTALLATION_ID: string;
  GITHUB_PRIVATE_KEY: string;

  // Stripe
  STRIPE_PAYMENT_SLUG: string;

  // Fourthwall
  FOURTHWALL_SLUG: string;
  FOURTHWALL_USER: string;
  FOURTHWALL_PASSWORD: string;

  // Outline
  OUTLINE_API_KEY: string;

  // Zulip
  ZULIP_BOT_USERNAME: string;
  ZULIP_BOT_API_KEY: string;
  ZULIP_USER_USERNAME: string;
  ZULIP_USER_API_KEY: string;
  ZULIP_DOMAIN: string;
}
