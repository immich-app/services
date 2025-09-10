/**
 * Approval validation logic
 * Checks if a pull request has been approved by authorized users
 */

import { createOctokitForInstallation } from './auth.js';
import { CheckRunManager } from './check-runs.js';

interface User {
  github: {
    username: string;
    id: number;
  };
  discord?: {
    username: string;
    id: number;
  };
  role: 'admin' | 'team' | 'contributor' | 'support';
  dev?: boolean;
}

interface Review {
  id: number;
  user: {
    login: string;
    id: number;
  };
  state: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'DISMISSED' | 'PENDING';
  submitted_at: string;
}

export interface ValidationResult {
  isApproved: boolean;
  summary: string;
  details: string;
  approvers: string[];
  reviews: Array<{ user: string; state: string; submittedAt: string }>;
}

export class ApprovalValidator {
  private allowedUsersUrl: string;
  private allowedUsersCache: { users: User[]; fetchedAt: number } | null = null;
  private readonly CACHE_TTL = 5 * 60 * 1000; // 5 minutes
  private appId: string;
  private privateKey: string;

  constructor(allowedUsersUrl: string, appId: string, privateKey: string) {
    this.allowedUsersUrl = allowedUsersUrl;
    this.appId = appId;
    this.privateKey = privateKey;
  }

  /**
   * Validate if a pull request has required approvals
   */
  async validatePullRequest(
    installationId: number,
    owner: string,
    repo: string,
    prNumber: number,
  ): Promise<ValidationResult> {
    // Fetch allowed users
    const allowedUsers = await this.getAllowedUsers();

    // Get authorized approvers (admin and team roles)
    const authorizedApprovers = allowedUsers
      .filter((user) => user.role === 'admin' || user.role === 'team')
      .map((user) => user.github);

    // Fetch PR reviews
    const reviews = await this.fetchPullRequestReviews(installationId, owner, repo, prNumber);

    // Process reviews to find valid approvals
    const approvalsByUser = new Map<number, Review>();

    // Process reviews in chronological order
    for (const review of reviews) {
      const existingReview = approvalsByUser.get(review.user.id);

      // Only update if this is a newer review or changes the approval state
      if (!existingReview || new Date(review.submitted_at) > new Date(existingReview.submitted_at)) {
        approvalsByUser.set(review.user.id, review);
      }
    }

    // Find approvals from authorized users
    const validApprovals: string[] = [];
    const allReviews: Array<{ user: string; state: string; submittedAt: string }> = [];

    for (const [userId, review] of approvalsByUser) {
      const reviewInfo = {
        user: review.user.login,
        state: review.state,
        submittedAt: new Date(review.submitted_at).toLocaleString(),
      };
      allReviews.push(reviewInfo);

      if (review.state === 'APPROVED') {
        const isAuthorized = authorizedApprovers.some((approver) => approver.id === userId);

        if (isAuthorized) {
          validApprovals.push(review.user.login);
        }
      }
    }

    // Sort reviews by date (newest first)
    allReviews.sort((a, b) => new Date(b.submittedAt).getTime() - new Date(a.submittedAt).getTime());

    // Determine if PR is approved
    const isApproved = validApprovals.length > 0;

    // Create output message
    const authorizedUsernames = authorizedApprovers.map((u) => u.username);
    const { summary, details } = CheckRunManager.createCheckOutput(
      isApproved,
      validApprovals,
      authorizedUsernames,
      allReviews,
    );

    return {
      isApproved,
      summary,
      details,
      approvers: validApprovals,
      reviews: allReviews,
    };
  }

  /**
   * Fetch the list of allowed users from the configured URL
   */
  private async getAllowedUsers(): Promise<User[]> {
    // Check cache first
    if (this.allowedUsersCache && Date.now() - this.allowedUsersCache.fetchedAt < this.CACHE_TTL) {
      return this.allowedUsersCache.users;
    }

    try {
      const response = await fetch(this.allowedUsersUrl);

      if (!response.ok) {
        throw new Error(`Failed to fetch allowed users: ${response.status}`);
      }

      const users = (await response.json()) as User[];

      // Update cache
      this.allowedUsersCache = {
        users,
        fetchedAt: Date.now(),
      };

      return users;
    } catch (error) {
      console.error('Error fetching allowed users:', error);

      // If we have cached data, use it even if expired
      if (this.allowedUsersCache) {
        console.warn('Using expired cache due to fetch error');
        return this.allowedUsersCache.users;
      }

      // Default to empty list if no cache and fetch failed
      return [];
    }
  }

  /**
   * Fetch all reviews for a pull request
   */
  private async fetchPullRequestReviews(
    installationId: number,
    owner: string,
    repo: string,
    prNumber: number,
  ): Promise<Review[]> {
    try {
      const octokit = createOctokitForInstallation(this.appId, this.privateKey, installationId);

      const response = await octokit.rest.pulls.listReviews({
        owner,
        repo,
        pull_number: prNumber,
      });

      return response.data as Review[];
    } catch (error) {
      console.error(`Failed to fetch PR reviews:`, error);
      return [];
    }
  }

  /**
   * Check if a specific user is authorized to approve
   */
  isUserAuthorized(userId: number, users: User[]): boolean {
    return users.some((user) => user.github.id === userId && (user.role === 'admin' || user.role === 'team'));
  }
}
