interface Env {
  // Outline
  OUTLINE_WEBHOOK_SECRET: string;

  // GitHub App
  GITHUB_APP_ID: string;
  GITHUB_APP_PRIVATE_KEY: string;
  GITHUB_INSTALLATION_ID: string;

  // Development (explicitly set to "true" in .dev.vars to skip webhook validation)
  SKIP_WEBHOOK_VALIDATION?: string;
}
