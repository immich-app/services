/**
 * Constants for the GitHub Approval Check application
 */

export const CHECK_NAME = 'Approval Check';

export function getCheckName(environment?: string): string {
  return environment && environment !== 'prod' ? `${CHECK_NAME} (${environment})` : CHECK_NAME;
}

const GREPTILE = { username: 'greptile-apps[bot]', id: 165_735_046 };
const KRITIKA = { username: 'futo-kritika[bot]', id: 338_622_031 };

export const REPO_BOT_APPROVERS: Record<string, Array<{ username: string; id: number }>> = {
  'immich-app/yucca': [GREPTILE, KRITIKA],
  'immich-app/yucca-o11y': [GREPTILE, KRITIKA],
  'immich-app/survey': [GREPTILE, KRITIKA],
  'immich-app/discord-bot': [GREPTILE, KRITIKA],
  'immich-app/devtools': [GREPTILE, KRITIKA],
  'immich-app/version': [GREPTILE, KRITIKA],
  'immich-app/pokedex': [KRITIKA],
};

export const CHECK_STATUS = {
  QUEUED: 'queued',
  IN_PROGRESS: 'in_progress',
  COMPLETED: 'completed',
} as const;

export const CHECK_CONCLUSION = {
  SUCCESS: 'success',
  FAILURE: 'failure',
  NEUTRAL: 'neutral',
  CANCELLED: 'cancelled',
  SKIPPED: 'skipped',
  TIMED_OUT: 'timed_out',
  ACTION_REQUIRED: 'action_required',
} as const;

export const MESSAGES = {
  APPROVED: {
    SUMMARY: '✅ Pull request has been approved by authorized team members.',
    TITLE: 'Approval Check',
  },
  AWAITING_APPROVAL: {
    SUMMARY: '⏳ Awaiting approval from authorized team members...',
    TITLE: 'Approval Check',
  },
  APPROVAL_REVOKED: {
    SUMMARY: '⚠️ Approval revoked - action required',
    DETAILS:
      'This pull request was previously approved but the approval is no longer valid. It requires re-approval from an authorized team member before it can be merged.',
  },
} as const;

export const WEBHOOK_EVENTS = {
  PULL_REQUEST: 'pull_request',
  PULL_REQUEST_REVIEW: 'pull_request_review',
  CHECK_SUITE: 'check_suite',
  CHECK_RUN: 'check_run',
} as const;

export const PR_ACTIONS = {
  OPENED: 'opened',
  REOPENED: 'reopened',
  SYNCHRONIZE: 'synchronize',
} as const;

export const REVIEW_ACTIONS = {
  SUBMITTED: 'submitted',
  DISMISSED: 'dismissed',
} as const;

export const CHECK_SUITE_ACTIONS = {
  REQUESTED: 'requested',
  REREQUESTED: 'rerequested',
} as const;

export const CHECK_RUN_ACTIONS = {
  REREQUESTED: 'rerequested',
} as const;
