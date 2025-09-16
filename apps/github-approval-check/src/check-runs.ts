/**
 * Check Runs API integration
 * Manages GitHub check runs for pull request approval status
 */

import { createOctokitForInstallation } from './auth.js';

export interface CheckRun {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  head_sha: string;
  pull_requests: Array<{ number: number }>;
}

export class CheckRunManager {
  private appId: string;
  private privateKey: string;

  constructor(appId: string, privateKey: string) {
    this.appId = appId;
    this.privateKey = privateKey;
  }

  /**
   * Create a new check run
   */
  async createCheckRun(
    installationId: number,
    owner: string,
    repo: string,
    headSha: string,
    name: string,
    status: 'queued' | 'in_progress' | 'completed',
  ): Promise<CheckRun> {
    const octokit = createOctokitForInstallation(this.appId, this.privateKey, installationId);

    const response = await octokit.rest.checks.create({
      owner,
      repo,
      name,
      head_sha: headSha,
      status,
      started_at: new Date().toISOString(),
      output: {
        title: 'Approval Check',
        summary: 'Validating pull request approvals...',
      },
    });

    if (!response.data?.id) {
      throw new Error('Failed to create check run: invalid response structure');
    }

    return response.data as CheckRun;
  }

  /**
   * Update an existing check run
   */
  async updateCheckRun(
    installationId: number,
    owner: string,
    repo: string,
    checkRunId: number,
    conclusion:
      | 'success'
      | 'failure'
      | 'neutral'
      | 'cancelled'
      | 'skipped'
      | 'timed_out'
      | 'action_required'
      | 'in_progress',
    summary: string,
    text: string,
  ): Promise<void> {
    const octokit = createOctokitForInstallation(this.appId, this.privateKey, installationId);

    const updateData: any = {
      owner,
      repo,
      check_run_id: checkRunId,
      output: {
        title: 'Approval Check',
        summary,
        text,
      },
    };

    if (conclusion === 'in_progress') {
      updateData.status = 'in_progress';
    } else {
      updateData.status = 'completed';
      updateData.conclusion = conclusion;
      updateData.completed_at = new Date().toISOString();
    }

    await octokit.rest.checks.update(updateData);
  }

  /**
   * List check runs for a specific commit
   */
  async listCheckRuns(installationId: number, owner: string, repo: string, ref: string): Promise<CheckRun[]> {
    const octokit = createOctokitForInstallation(this.appId, this.privateKey, installationId);

    const response = await octokit.rest.checks.listForRef({
      owner,
      repo,
      ref,
    });

    return response.data.check_runs as CheckRun[];
  }

  /**
   * Create a detailed output message for the check run
   */
  static createCheckOutput(
    isApproved: boolean,
    approvers: string[],
    reviews: Array<{ user: string; state: string; submittedAt: string }>,
  ): { summary: string; details: string } {
    const summary = isApproved
      ? `✅ Pull request has been approved by authorized team members.`
      : `⏳ Awaiting approval from authorized team members...`;

    let details = '## Approval Status\n\n';

    if (isApproved) {
      details += '### ✅ Approved by:\n';
      for (const approver of approvers) {
        details += `- @${approver}\n`;
      }
    } else {
      details += '### ⏳ Waiting for approval\n';
      details += 'This pull request requires approval from authorized team members before it can be merged.\n';
    }

    // Add review history if there are reviews
    if (reviews.length > 0) {
      details += '\n### 📝 Review History:\n';
      for (const review of reviews) {
        const emoji = review.state === 'APPROVED' ? '✅' : review.state === 'CHANGES_REQUESTED' ? '❌' : '💬';
        details += `- ${emoji} @${review.user} - ${review.state} (${review.submittedAt})\n`;
      }
    }

    details += '\n---\n';
    details += '*This check ensures that pull requests are approved by authorized team members before merging.*\n';

    if (!isApproved) {
      details += '*If you believe you should have approval permissions, please contact the repository administrators.*';
    }

    return { summary, details };
  }
}
