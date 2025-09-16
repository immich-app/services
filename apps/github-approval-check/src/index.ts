import { ApprovalValidator } from './approval.js';
import { CheckRunManager } from './check-runs.js';
import {
  CHECK_RUN_ACTIONS,
  CHECK_SUITE_ACTIONS,
  PR_ACTIONS,
  REVIEW_ACTIONS,
  WEBHOOK_EVENTS,
  getCheckName,
} from './constants.js';
import { getDevModeConfig, shouldProcessInDevMode } from './dev-mode.js';
import { handleApprovalCheck, validatePullRequest, validateWebhookPayload } from './helpers.js';
import type { CheckRunEvent, CheckSuiteEvent, PullRequestEvent, PullRequestReviewEvent } from './types.js';
import { verifyWebhookSignature } from './webhook.js';

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // Health check endpoint
    if (url.pathname === '/health') {
      return new Response(JSON.stringify({ status: 'healthy' }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // GitHub webhook endpoint
    if (url.pathname === '/webhook' && request.method === 'POST') {
      try {
        // Verify webhook signature
        const signature = request.headers.get('X-Hub-Signature-256');
        if (!signature) {
          console.log('[webhook] Missing signature header');
          return new Response('Missing signature', { status: 401 });
        }

        // Validate environment variables
        if (!env.GITHUB_APP_ID || !env.GITHUB_APP_PRIVATE_KEY || !env.GITHUB_WEBHOOK_SECRET || !env.ALLOWED_USERS_URL) {
          console.error('[webhook] Missing required environment variables');
          return new Response('Server configuration error', { status: 500 });
        }

        // Verify signature
        const body = await request.text();
        const isValid = await verifyWebhookSignature(body, signature, env.GITHUB_WEBHOOK_SECRET);

        if (!isValid) {
          console.log('[webhook] Invalid signature');
          return new Response('Invalid signature', { status: 401 });
        }

        // Parse webhook payload
        const payload = JSON.parse(body);
        const eventType = request.headers.get('X-GitHub-Event');
        const repoName = payload.repository?.name;
        const prNumber = payload.pull_request?.number || payload.number;

        console.log(`[webhook] Received ${eventType} event for repo: ${repoName}, PR: ${prNumber}`);

        // Check dev mode filtering
        const devModeConfig = getDevModeConfig(env);
        if (devModeConfig.isDevMode) {
          console.log(`[webhook] Dev mode enabled - PR: ${devModeConfig.prNumber}, Repo: ${devModeConfig.repoName}`);
        }
        
        if (!shouldProcessInDevMode(devModeConfig, repoName, prNumber)) {
          return new Response('OK', { status: 200 });
        }

        // Initialize services
        const checkRunManager = new CheckRunManager(env.GITHUB_APP_ID, env.GITHUB_APP_PRIVATE_KEY);
        const approvalValidator = new ApprovalValidator(
          env.ALLOWED_USERS_URL,
          env.GITHUB_APP_ID,
          env.GITHUB_APP_PRIVATE_KEY,
        );

        // Route to appropriate handler
        switch (eventType) {
          case WEBHOOK_EVENTS.PULL_REQUEST: {
            await handlePullRequestEvent(payload as PullRequestEvent, env, checkRunManager, approvalValidator);
            break;
          }

          case WEBHOOK_EVENTS.PULL_REQUEST_REVIEW: {
            await handlePullRequestReviewEvent(payload as PullRequestReviewEvent, env, checkRunManager, approvalValidator);
            break;
          }

          case WEBHOOK_EVENTS.CHECK_SUITE: {
            await handleCheckSuiteEvent(payload as CheckSuiteEvent, env, checkRunManager, approvalValidator);
            break;
          }

          case WEBHOOK_EVENTS.CHECK_RUN: {
            if (payload.action === CHECK_RUN_ACTIONS.REREQUESTED) {
              await handleCheckRunRerequest(payload as CheckRunEvent, env, checkRunManager, approvalValidator);
            }
            break;
          }

          default: {
            console.log(`[webhook] Ignoring event type: ${eventType}`);
          }
        }

        return new Response('OK', { status: 200 });
      } catch (error) {
        console.error('[webhook] Processing error:', error);
        return new Response('Internal server error', { status: 500 });
      }
    }

    return new Response('Not Found', { status: 404 });
  },
};

/**
 * Handles pull_request events (opened, reopened, synchronize)
 */
async function handlePullRequestEvent(
  event: PullRequestEvent,
  env: Env,
  checkRunManager: CheckRunManager,
  approvalValidator: ApprovalValidator,
): Promise<void> {
  const { action, pull_request } = event;

  // Only process relevant actions
  if (!Object.values(PR_ACTIONS).includes(action as any)) {
    console.log(`[pull_request] Ignoring action: ${action}`);
    return;
  }

  const { installationId, owner, repo } = await validateWebhookPayload(event, 'pull_request', env.GITHUB_APP_ID, env.GITHUB_APP_PRIVATE_KEY);
  const pr = validatePullRequest(pull_request, 'pull_request');

  await handleApprovalCheck(
    {
      installationId,
      owner,
      repo,
      prNumber: pr.number,
      headSha: pr.head.sha,
      eventType: 'pull_request',
      environment: env.ENVIRONMENT,
    },
    checkRunManager,
    approvalValidator,
  );
}

/**
 * Handles pull_request_review events (submitted, dismissed)
 */
async function handlePullRequestReviewEvent(
  event: PullRequestReviewEvent,
  env: Env,
  checkRunManager: CheckRunManager,
  approvalValidator: ApprovalValidator,
): Promise<void> {
  const { action, pull_request } = event;

  // Only process relevant actions
  if (!Object.values(REVIEW_ACTIONS).includes(action as any)) {
    console.log(`[pull_request_review] Ignoring action: ${action}`);
    return;
  }

  const { installationId, owner, repo } = await validateWebhookPayload(event, 'pull_request_review', env.GITHUB_APP_ID, env.GITHUB_APP_PRIVATE_KEY);
  const pr = validatePullRequest(pull_request, 'pull_request_review');

  await handleApprovalCheck(
    {
      installationId,
      owner,
      repo,
      prNumber: pr.number,
      headSha: pr.head.sha,
      eventType: 'pull_request_review',
      environment: env.ENVIRONMENT,
    },
    checkRunManager,
    approvalValidator,
  );
}

/**
 * Handles check_suite events (requested, rerequested)
 */
async function handleCheckSuiteEvent(
  event: CheckSuiteEvent,
  env: Env,
  checkRunManager: CheckRunManager,
  approvalValidator: ApprovalValidator,
): Promise<void> {
  const { action, check_suite } = event;

  // Only process relevant actions
  if (!Object.values(CHECK_SUITE_ACTIONS).includes(action as any)) {
    console.log(`[check_suite] Ignoring action: ${action}`);
    return;
  }

  // Only process if there are pull requests
  if (!check_suite.pull_requests || check_suite.pull_requests.length === 0) {
    console.log('[check_suite] No associated pull requests');
    return;
  }

  const { installationId, owner, repo } = await validateWebhookPayload(event, 'check_suite', env.GITHUB_APP_ID, env.GITHUB_APP_PRIVATE_KEY);

  if (!check_suite.head_sha) {
    console.log('[check_suite] Missing head SHA');
    throw new Error('Invalid check_suite payload: missing head_sha');
  }

  // Process first pull request
  const pr = check_suite.pull_requests[0];

  await handleApprovalCheck(
    {
      installationId,
      owner,
      repo,
      prNumber: pr.number,
      headSha: check_suite.head_sha,
      eventType: 'check_suite',
      environment: env.ENVIRONMENT,
    },
    checkRunManager,
    approvalValidator,
  );
}

/**
 * Handles check_run rerun requests
 */
async function handleCheckRunRerequest(
  event: CheckRunEvent,
  env: Env,
  checkRunManager: CheckRunManager,
  approvalValidator: ApprovalValidator,
): Promise<void> {
  const { check_run } = event;

  // Only handle our own check runs
  const expectedCheckName = getCheckName(env.ENVIRONMENT);
  if (check_run.name !== expectedCheckName) {
    console.log(`[check_run] Ignoring check: ${check_run.name}`);
    return;
  }

  // Get associated pull requests
  const pullRequests = check_run.pull_requests;
  if (!pullRequests || pullRequests.length === 0) {
    console.log('[check_run] No associated pull requests');
    return;
  }

  const { installationId, owner, repo } = await validateWebhookPayload(event, 'check_run', env.GITHUB_APP_ID, env.GITHUB_APP_PRIVATE_KEY);

  if (!check_run.id) {
    console.log('[check_run] Missing check run ID');
    throw new Error('Invalid check_run payload: missing check_run.id');
  }

  const pr = pullRequests[0];

  await handleApprovalCheck(
    {
      installationId,
      owner,
      repo,
      prNumber: pr.number,
      headSha: check_run.head_sha,
      eventType: 'check_run',
      environment: env.ENVIRONMENT,
    },
    checkRunManager,
    approvalValidator,
  );
}