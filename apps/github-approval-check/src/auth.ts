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
  // Validate inputs
  if (!appId || typeof appId !== 'string') {
    throw new Error('Invalid GitHub App ID provided to createOctokitForInstallation');
  }

  if (!privateKey || typeof privateKey !== 'string') {
    console.error('Invalid privateKey:', { 
      hasPrivateKey: !!privateKey, 
      type: typeof privateKey,
      length: privateKey ? String(privateKey).length : 0
    });
    throw new Error('Invalid GitHub App Private Key provided to createOctokitForInstallation');
  }

  if (!installationId || typeof installationId !== 'number') {
    throw new Error('Invalid Installation ID provided to createOctokitForInstallation');
  }

  // Ensure the private key has proper format
  let formattedPrivateKey = privateKey.trim();
  
  // If the private key doesn't have proper line breaks, it might have been improperly stored
  // This can happen when the key is stored in environment variables without proper escaping
  if (!formattedPrivateKey.includes('\n') && formattedPrivateKey.includes('-----BEGIN')) {
    // Try to fix the format by adding line breaks after BEGIN and before END
    formattedPrivateKey = formattedPrivateKey
      .replace(/-----BEGIN RSA PRIVATE KEY-----/, '-----BEGIN RSA PRIVATE KEY-----\n')
      .replace(/-----END RSA PRIVATE KEY-----/, '\n-----END RSA PRIVATE KEY-----')
      .replace(/([^-\n])-----END/, '$1\n-----END');
  }

  try {
    // Create an Octokit instance with the auth
    const octokit = new Octokit({
      authStrategy: createAppAuth,
      auth: {
        appId,
        privateKey: formattedPrivateKey,
        installationId,
      },
      userAgent: 'Immich-Approval-Check-App',
    });
    
    // Verify the structure
    if (!octokit.rest || !octokit.rest.checks) {
      console.error('Octokit structure issue:', {
        hasRest: !!octokit.rest,
        hasChecks: !!octokit.rest?.checks,
        octokitKeys: Object.keys(octokit).slice(0, 10),
      });
      throw new Error('Octokit instance is missing expected methods');
    }
    
    return octokit;
  } catch (error) {
    console.error('Failed to create Octokit instance:', error);
    console.error('AppId:', appId);
    console.error('InstallationId:', installationId);
    console.error('PrivateKey format check:', {
      hasBeginMarker: formattedPrivateKey.includes('-----BEGIN'),
      hasEndMarker: formattedPrivateKey.includes('-----END'),
      hasNewlines: formattedPrivateKey.includes('\n'),
      length: formattedPrivateKey.length,
      firstChars: formattedPrivateKey.slice(0, 50),
      lastChars: formattedPrivateKey.slice(-50)
    });
    throw error;
  }
}
