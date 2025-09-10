/**
 * Helper functions for GitHub Approval Check
 */

import { ApprovalValidator } from './approval.js';
import { CheckRunManager } from './check-runs.js';
import { CHECK_CONCLUSION, CHECK_NAME, CHECK_STATUS, MESSAGES } from './constants.js';

interface BaseEventPayload {
  installation?: { id: number };
  repository?: {
    owner?: { login: string };
    name?: string;
  };
}

interface PullRequestInfo {
  number: number;
  head: { sha: string };
}

/**
 * Validates that required fields are present in the webhook payload
 */
export function validateWebhookPayload(
  event: BaseEventPayload,
  eventType: string,
): { installationId: number; owner: string; repo: string } {
  if (!event.installation?.id) {
    console.log(`[${eventType}] Missing installation ID`);
    throw new Error(`Invalid ${eventType} payload: missing installation.id`);
  }

  if (!event.repository?.owner?.login || !event.repository?.name) {
    console.log(`[${eventType}] Missing repository information`);
    throw new Error(`Invalid ${eventType} payload: missing repository information`);
  }

  return {
    installationId: event.installation.id,
    owner: event.repository.owner.login,
    repo: event.repository.name,
  };
}

/**
 * Validates pull request information
 */
export function validatePullRequest(pullRequest: any, eventType: string): PullRequestInfo {
  if (!pullRequest?.head?.sha || !pullRequest?.number) {
    console.log(`[${eventType}] Missing pull request information`);
    throw new Error(`Invalid ${eventType} payload: missing pull request information`);
  }

  return {
    number: pullRequest.number,
    head: { sha: pullRequest.head.sha },
  };
}

/**
 * Handles approval check logic for all event types
 * 
 * Behavior:
 * - If approved: Creates/updates check with success status
 * - If not approved + check exists: Updates to action_required 
 * - If not approved + no check: Does nothing (keeps PR clean)
 */
export async function handleApprovalCheck(
  params: {
    installationId: number;
    owner: string;
    repo: string;
    prNumber: number;
    headSha: string;
    eventType: string;
  },
  checkRunManager: CheckRunManager,
  approvalValidator: ApprovalValidator,
): Promise<void> {
  const { installationId, owner, repo, prNumber, headSha, eventType } = params;

  console.log(`[${eventType}] Processing PR #${prNumber} (SHA: ${headSha.slice(0, 7)})`);

  // Validate current approvals
  const validationResult = await approvalValidator.validatePullRequest(
    installationId,
    owner,
    repo,
    prNumber,
  );

  console.log(`[${eventType}] PR #${prNumber} approval status: ${validationResult.isApproved ? 'approved' : 'not approved'}`);

  // Get existing check runs
  const checkRuns = await checkRunManager.listCheckRuns(installationId, owner, repo, headSha);
  const existingCheck = checkRuns.find((cr: any) => cr.name === CHECK_NAME);

  if (validationResult.isApproved) {
    // PR is approved - ensure check exists and shows success
    if (existingCheck) {
      console.log(`[${eventType}] Updating existing check to success for PR #${prNumber}`);
      await checkRunManager.updateCheckRun(
        installationId,
        owner,
        repo,
        existingCheck.id,
        CHECK_CONCLUSION.SUCCESS,
        validationResult.summary,
        validationResult.details,
      );
    } else {
      console.log(`[${eventType}] Creating new success check for PR #${prNumber}`);
      const checkRun = await checkRunManager.createCheckRun(
        installationId,
        owner,
        repo,
        headSha,
        CHECK_NAME,
        CHECK_STATUS.IN_PROGRESS,
      );

      await checkRunManager.updateCheckRun(
        installationId,
        owner,
        repo,
        checkRun.id,
        CHECK_CONCLUSION.SUCCESS,
        validationResult.summary,
        validationResult.details,
      );
    }
  } else if (existingCheck) {
    // PR is not approved but check exists - update to action_required
    console.log(`[${eventType}] Updating check to action_required for PR #${prNumber}`);
    
    await checkRunManager.updateCheckRun(
      installationId,
      owner,
      repo,
      existingCheck.id,
      CHECK_CONCLUSION.ACTION_REQUIRED,
      MESSAGES.APPROVAL_REVOKED.SUMMARY,
      MESSAGES.APPROVAL_REVOKED.DETAILS,
    );
  } else {
    // PR is not approved and no check exists - do nothing
    console.log(`[${eventType}] PR #${prNumber} not approved, no check to create`);
  }
}