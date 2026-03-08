export type AppConfig = {
  botToken: string;
  github: {
    appId: string;
    installationId: string;
    privateKey: string;
  };
  slugs: {
    githubWebhook?: string;
    githubStatusWebhook?: string;
    stripeWebhook?: string;
    fourthwallWebhook?: string;
  };
  zulip: {
    bot: { username: string; apiKey: string };
    user: { username: string; apiKey: string };
    realm: string;
  };
  fourthwall: {
    user: string;
    password: string;
  };
  outline: {
    apiKey: string;
  };
};

export const getConfig = (env: Env): AppConfig => ({
  botToken: env.BOT_TOKEN,
  github: {
    appId: env.GITHUB_APP_ID,
    installationId: env.GITHUB_INSTALLATION_ID,
    privateKey: env.GITHUB_PRIVATE_KEY,
  },
  slugs: {
    githubWebhook: env.GITHUB_SLUG,
    githubStatusWebhook: env.GITHUB_STATUS_SLUG,
    stripeWebhook: env.STRIPE_PAYMENT_SLUG,
    fourthwallWebhook: env.FOURTHWALL_SLUG,
  },
  zulip: {
    bot: { username: env.ZULIP_BOT_USERNAME, apiKey: env.ZULIP_BOT_API_KEY },
    user: { username: env.ZULIP_USER_USERNAME, apiKey: env.ZULIP_USER_API_KEY },
    realm: env.ZULIP_DOMAIN,
  },
  fourthwall: {
    user: env.FOURTHWALL_USER,
    password: env.FOURTHWALL_PASSWORD,
  },
  outline: {
    apiKey: env.OUTLINE_API_KEY,
  },
});
