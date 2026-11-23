import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApprovalValidator, ValidationResult } from './approval.js';
import { createOctokitForInstallation } from './auth.js';
import { CheckRunManager } from './check-runs.js';
import { handleApprovalCheck } from './helpers.js';

vi.mock('./auth.js', () => ({ createOctokitForInstallation: vi.fn() }));

const newCheckRun = (overrides: { id: number; name: string }) => ({
  status: 'completed',
  conclusion: 'success',
  head_sha: 'abc1234',
  pull_requests: [],
  ...overrides,
});

const newOctokit = (checkRuns: Array<ReturnType<typeof newCheckRun>>) => ({
  rest: {
    checks: {
      listForRef: vi.fn().mockResolvedValue({ data: { check_runs: checkRuns } }),
      create: vi.fn().mockResolvedValue({ data: { id: 1 } }),
      update: vi.fn().mockResolvedValue({ data: {} }),
    },
  },
});

const newValidator = (isApproved: boolean) =>
  ({
    validatePullRequest: vi.fn().mockResolvedValue({
      isApproved,
      hasReviews: isApproved,
      summary: 'summary',
      details: 'details',
      approvers: isApproved ? ['alex'] : [],
      reviews: [],
    } satisfies ValidationResult),
  }) as unknown as ApprovalValidator;

const params = {
  installationId: 1,
  owner: 'immich-app',
  repo: 'immich',
  prNumber: 123,
  headSha: 'abc1234',
  eventType: 'pull_request_review',
};

describe(handleApprovalCheck.name, () => {
  let octokit: ReturnType<typeof newOctokit>;

  const setup = (checkRuns: Array<ReturnType<typeof newCheckRun>>) => {
    octokit = newOctokit(checkRuns);
    vi.mocked(createOctokitForInstallation).mockReturnValue(octokit as never);
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('creates an approved check already completed', async () => {
    setup([]);

    await handleApprovalCheck(params, new CheckRunManager('app', 'key'), newValidator(true));

    expect(octokit.rest.checks.create).toHaveBeenCalledOnce();
    expect(octokit.rest.checks.create).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Approval Check',
        head_sha: 'abc1234',
        status: 'completed',
        conclusion: 'success',
        output: { title: 'Approval Check', summary: 'summary', text: 'details' },
      }),
    );
    expect(octokit.rest.checks.update).not.toHaveBeenCalled();
  });

  it('updates an existing check when approved', async () => {
    setup([newCheckRun({ id: 42, name: 'Approval Check' })]);

    await handleApprovalCheck(params, new CheckRunManager('app', 'key'), newValidator(true));

    expect(octokit.rest.checks.update).toHaveBeenCalledWith(
      expect.objectContaining({ check_run_id: 42, status: 'completed', conclusion: 'success' }),
    );
    expect(octokit.rest.checks.create).not.toHaveBeenCalled();
  });

  it('creates no check when not approved', async () => {
    setup([]);

    await handleApprovalCheck(params, new CheckRunManager('app', 'key'), newValidator(false));

    expect(octokit.rest.checks.create).not.toHaveBeenCalled();
    expect(octokit.rest.checks.update).not.toHaveBeenCalled();
  });
});
