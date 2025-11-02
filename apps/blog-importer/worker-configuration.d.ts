interface Env {
  // R2 Binding
  STATIC_BUCKET: R2Bucket;
  R2_PUBLIC_URL: string;

  // Outline
  OUTLINE_WEBHOOK_SECRET: string;
  OUTLINE_BASE_URL: string;

  // GitHub App
  GITHUB_APP_ID: string;
  GITHUB_APP_PRIVATE_KEY: string;
  GITHUB_INSTALLATION_ID: string;
}
