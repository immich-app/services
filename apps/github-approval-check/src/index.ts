import { verifyWebhookSignature } from './webhook.js';
import { CheckRunManager } from './check-runs.js';
import { ApprovalValidator } from './approval.js';
import type { 
  PullRequestEvent, 
  PullRequestReviewEvent, 
  CheckSuiteEvent,
  CheckRunEvent 
} from './types.js';

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
        const body = await request.text();
        const signature = request.headers.get('X-Hub-Signature-256');
        
        if (!signature) {
          return new Response('Missing signature', { status: 401 });
        }

        const isValid = await verifyWebhookSignature(
          body,
          signature,
          env.GITHUB_WEBHOOK_SECRET
        );

        if (!isValid) {
          return new Response('Invalid signature', { status: 401 });
        }

        // Parse the webhook payload
        const payload = JSON.parse(body);
        const eventType = request.headers.get('X-GitHub-Event');

        // Initialize services
        const checkRunManager = new CheckRunManager(env.GITHUB_APP_ID, env.GITHUB_APP_PRIVATE_KEY);
        const approvalValidator = new ApprovalValidator(env.ALLOWED_USERS_URL, env.GITHUB_APP_ID, env.GITHUB_APP_PRIVATE_KEY);

        // Handle different webhook events
        switch (eventType) {
          case 'pull_request': {
            await handlePullRequestEvent(
              payload as PullRequestEvent,
              checkRunManager,
              approvalValidator
            );
            break;
          }

          case 'pull_request_review': {
            await handlePullRequestReviewEvent(
              payload as PullRequestReviewEvent,
              checkRunManager,
              approvalValidator
            );
            break;
          }

          case 'check_suite': {
            await handleCheckSuiteEvent(
              payload as CheckSuiteEvent,
              checkRunManager,
              approvalValidator
            );
            break;
          }

          case 'check_run': {
            if (payload.action === 'rerequested') {
              await handleCheckRunRerequest(
                payload as CheckRunEvent,
                checkRunManager,
                approvalValidator
              );
            }
            break;
          }

          default: {
            console.log(`Ignoring event type: ${eventType}`);
          }
        }

        return new Response('OK', { status: 200 });
      } catch (error) {
        console.error('Webhook processing error:', error);
        return new Response('Internal server error', { status: 500 });
      }
    }

    return new Response('Not Found', { status: 404 });
  },
};

async function handlePullRequestEvent(
  event: PullRequestEvent,
  checkRunManager: CheckRunManager,
  approvalValidator: ApprovalValidator
): Promise<void> {
  const { action, pull_request, repository, installation } = event;
  
  // Only process opened, reopened, or synchronize events
  if (!['opened', 'reopened', 'synchronize'].includes(action)) {
    return;
  }

  // Create or update the check run
  const checkRun = await checkRunManager.createCheckRun(
    installation.id,
    repository.owner.login,
    repository.name,
    pull_request.head.sha,
    'Approval Check',
    'in_progress'
  );

  // Validate current approvals
  const validationResult = await approvalValidator.validatePullRequest(
    installation.id,
    repository.owner.login,
    repository.name,
    pull_request.number
  );

  // Update check run with result
  await checkRunManager.updateCheckRun(
    installation.id,
    repository.owner.login,
    repository.name,
    checkRun.id,
    validationResult.isApproved ? 'success' : 'failure',
    validationResult.summary,
    validationResult.details
  );
}

async function handlePullRequestReviewEvent(
  event: PullRequestReviewEvent,
  checkRunManager: CheckRunManager,
  approvalValidator: ApprovalValidator
): Promise<void> {
  const { action, pull_request, repository, installation } = event;

  // Only process submitted reviews
  if (action !== 'submitted') {
    return;
  }

  // Get the existing check run for this PR
  const checkRuns = await checkRunManager.listCheckRuns(
    installation.id,
    repository.owner.login,
    repository.name,
    pull_request.head.sha
  );

  let approvalCheck = checkRuns.find((cr: any) => cr.name === 'Approval Check');
  
  if (!approvalCheck) {
    // Create new check run if it doesn't exist
    approvalCheck = await checkRunManager.createCheckRun(
      installation.id,
      repository.owner.login,
      repository.name,
      pull_request.head.sha,
      'Approval Check',
      'in_progress'
    );
  }

  // Re-validate approvals
  const validationResult = await approvalValidator.validatePullRequest(
    installation.id,
    repository.owner.login,
    repository.name,
    pull_request.number
  );

  // Update check run with new result
  await checkRunManager.updateCheckRun(
    installation.id,
    repository.owner.login,
    repository.name,
    approvalCheck.id,
    validationResult.isApproved ? 'success' : 'failure',
    validationResult.summary,
    validationResult.details
  );
}

async function handleCheckSuiteEvent(
  event: CheckSuiteEvent,
  checkRunManager: CheckRunManager,
  approvalValidator: ApprovalValidator
): Promise<void> {
  const { action, check_suite, repository, installation } = event;

  // Only process requested or rerequested events
  if (!['requested', 'rerequested'].includes(action)) {
    return;
  }

  // Only process if there are pull requests
  if (!check_suite.pull_requests || check_suite.pull_requests.length === 0) {
    return;
  }

  // Create check run for the first pull request
  const pr = check_suite.pull_requests[0];
  
  const checkRun = await checkRunManager.createCheckRun(
    installation.id,
    repository.owner.login,
    repository.name,
    check_suite.head_sha,
    'Approval Check',
    'in_progress'
  );

  // Validate approvals
  const validationResult = await approvalValidator.validatePullRequest(
    installation.id,
    repository.owner.login,
    repository.name,
    pr.number
  );

  // Update check run with result
  await checkRunManager.updateCheckRun(
    installation.id,
    repository.owner.login,
    repository.name,
    checkRun.id,
    validationResult.isApproved ? 'success' : 'failure',
    validationResult.summary,
    validationResult.details
  );
}

async function handleCheckRunRerequest(
  event: CheckRunEvent,
  checkRunManager: CheckRunManager,
  approvalValidator: ApprovalValidator
): Promise<void> {
  const { check_run, repository, installation } = event;

  // Only handle our own check runs
  if (check_run.name !== 'Approval Check') {
    return;
  }

  // Get associated pull requests
  const pullRequests = check_run.pull_requests;
  if (!pullRequests || pullRequests.length === 0) {
    return;
  }

  const pr = pullRequests[0];

  // Update check to in_progress
  await checkRunManager.updateCheckRun(
    installation.id,
    repository.owner.login,
    repository.name,
    check_run.id,
    'in_progress',
    'Re-validating approvals...',
    ''
  );

  // Re-validate approvals
  const validationResult = await approvalValidator.validatePullRequest(
    installation.id,
    repository.owner.login,
    repository.name,
    pr.number
  );

  // Update check run with result
  await checkRunManager.updateCheckRun(
    installation.id,
    repository.owner.login,
    repository.name,
    check_run.id,
    validationResult.isApproved ? 'success' : 'failure',
    validationResult.summary,
    validationResult.details
  );
}