/**
 * Dev mode configuration and filtering
 */

// In dev mode, only process webhooks for the services repository
const DEV_MODE_REPO = 'services';

export interface DevModeConfig {
  isDevMode: boolean;
  prNumber?: number;
  repoName?: string;
}

/**
 * Parse dev mode configuration from environment
 */
export function getDevModeConfig(env: Env): DevModeConfig {
  // Check if we're in dev mode based on environment or stage
  const isDevEnvironment = env.ENVIRONMENT === 'dev';
  const isPRDeployment = env.STAGE?.startsWith('-pr-') || false;

  // Extract PR number from stage (e.g., '-pr-123' -> 123)
  let prNumber: number | undefined;
  if (env.DEV_PR_NUMBER) {
    prNumber = Number.parseInt(env.DEV_PR_NUMBER, 10);
  } else if (isPRDeployment && env.STAGE) {
    const match = env.STAGE.match(/-pr-(\d+)/);
    if (match) {
      prNumber = Number.parseInt(match[1], 10);
    }
  }

  // Dev mode is enabled if we have a PR deployment or explicit dev environment
  const isDevMode = isDevEnvironment || isPRDeployment;

  // In dev mode, always use the services repo
  const repoName = isDevMode ? DEV_MODE_REPO : undefined;

  return {
    isDevMode,
    prNumber,
    repoName,
  };
}

/**
 * Check if we should process this webhook event in dev mode
 */
export function shouldProcessInDevMode(
  config: DevModeConfig,
  repoName: string | undefined,
  prNumber: number | undefined,
): boolean {
  // If not in dev mode, process everything
  if (!config.isDevMode) {
    return true;
  }

  // In dev mode, must match repo name if specified
  if (config.repoName && repoName !== config.repoName) {
    console.log(`[dev-mode] Skipping repo ${repoName} (only processing ${config.repoName})`);
    return false;
  }

  // In dev mode with PR number, must match PR
  if (config.prNumber && prNumber !== config.prNumber) {
    console.log(`[dev-mode] Skipping PR #${prNumber} (only processing PR #${config.prNumber})`);
    return false;
  }

  return true;
}
