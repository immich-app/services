import { createAppAuth } from '@octokit/auth-app';

interface GitHubAppConfig {
  appId: string;
  privateKey: string;
  installationId: number;
}

export async function createInstallationToken(config: GitHubAppConfig): Promise<string> {
  const auth = createAppAuth({
    appId: config.appId,
    privateKey: formatPrivateKey(config.privateKey),
    installationId: config.installationId,
  });

  const { token } = await auth({ type: 'installation' });
  return token;
}

function formatPrivateKey(key: string): string {
  let formatted = key.trim();
  if (!formatted.includes('\n') && formatted.includes('-----BEGIN')) {
    formatted = formatted
      .replace(/-----BEGIN RSA PRIVATE KEY-----/, '-----BEGIN RSA PRIVATE KEY-----\n')
      .replace(/-----END RSA PRIVATE KEY-----/, '\n-----END RSA PRIVATE KEY-----')
      .replace(/-----BEGIN PRIVATE KEY-----/, '-----BEGIN PRIVATE KEY-----\n')
      .replace(/-----END PRIVATE KEY-----/, '\n-----END PRIVATE KEY-----');
  }
  return formatted;
}
