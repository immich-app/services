/**
 * GitHub App authentication module using Octokit
 * Handles authentication and provides configured Octokit instances
 */

import { createAppAuth } from '@octokit/auth-app';
import { Octokit } from '@octokit/rest';

/**
 * Create an authenticated Octokit instance for a GitHub App installation
 */
export function createOctokitForInstallation(
  appId: string,
  privateKey: string,
  installationId: number
): Octokit {
  const auth = createAppAuth({
    appId,
    privateKey,
    installationId,
  });

  return new Octokit({
    auth,
    userAgent: 'Immich-Approval-Check-App',
  });
}
