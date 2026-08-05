/**
 * Approval validation logic
 * Checks if a pull request has been approved by authorized users
 */

import { createOctokitForInstallation, getInstallationId } from './auth.js';
import { CheckRunManager } from './check-runs.js';

type Role = 'immich_admin' | 'team' | 'immich' | 'contributor' | 'support' | 'futo' | 'yucca';

interface User {
  github: {
    username: string;
    id: number;
  };
  discord?: {
    username: string;
    id: number;
  };
  /** @deprecated Use `roles` instead */
  role?: Role;
  roles?: Role[];
  dev?: boolean;
}

function hasApproverRole(user: User): boolean {
  const roles = user.roles ?? (user.role ? [user.role] : []);
  return roles.includes('immich_admin') || roles.includes('team') || roles.includes('immich');
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
  hasReviews: boolean;
  summary: string;
  details: string;
  approvers: string[];
  reviews: Array<{ user: string; state: string; submittedAt: string }>;
}

export class ApprovalValidator {
  private allowedUsersRepo: string;
  private allowedUsersPath: string;
  private allowedUsersCache: { users: User[]; fetchedAt: number } | null = null;
  private readonly CACHE_TTL = 5 * 60 * 1000; // 5 minutes
  private appId: string;
  private privateKey: string;

  constructor(allowedUsersRepo: string, allowedUsersPath: string, appId: string, privateKey: string) {
    this.allowedUsersRepo = allowedUsersRepo;
    this.allowedUsersPath = allowedUsersPath;
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
    const authorizedApprovers = allowedUsers.filter((user) => hasApproverRole(user)).map((user) => user.github);

    // Fetch PR reviews
    const reviews = await this.fetchPullRequestReviews(installationId, owner, repo, prNumber);
    console.log(`[approval] DEBUG: All reviews fetched for PR #${prNumber}:`, JSON.stringify(reviews, null, 2));

    // Process reviews to find valid approvals
    const approvalsByUser = new Map<number, Review>();

    // Process reviews in chronological order
    for (const review of reviews) {
      if (review.state === 'COMMENTED') {
        continue;
      }

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

    console.log(
      `[approval] DEBUG: Reviews by valid users (after deduplication):`,
      JSON.stringify(
        [...approvalsByUser].map(([userId, review]) => ({
          userId,
          login: review.user.login,
          state: review.state,
          submitted_at: review.submitted_at,
        })),
        null,
        2,
      ),
    );
    console.log(`[approval] DEBUG: Valid approvals from authorized users:`, JSON.stringify(validApprovals, null, 2));

    // Sort reviews by date (newest first)
    allReviews.sort((a, b) => new Date(b.submittedAt).getTime() - new Date(a.submittedAt).getTime());

    // Determine if PR is approved
    const isApproved = validApprovals.length > 0;
    const hasReviews = allReviews.length > 0;

    // Create output message
    const { summary, details } = CheckRunManager.createCheckOutput(isApproved, validApprovals, allReviews);

    return {
      isApproved,
      hasReviews,
      summary,
      details,
      approvers: validApprovals,
      reviews: allReviews,
    };
  }

  /**
   * Fetch the list of allowed users from the configured repository.
   *
   * The file lives in a private repository, so this reads it through the
   * GitHub App installation rather than over an unauthenticated URL.
   */
  private async getAllowedUsers(): Promise<User[]> {
    // Check cache first
    if (this.allowedUsersCache && Date.now() - this.allowedUsersCache.fetchedAt < this.CACHE_TTL) {
      return this.allowedUsersCache.users;
    }

    const [owner, repo] = this.allowedUsersRepo.split('/', 2);

    try {
      if (!owner || !repo) {
        throw new Error(`Invalid allowed users repo: ${this.allowedUsersRepo}`);
      }

      const installationId = await getInstallationId(this.appId, this.privateKey, owner, repo);
      const octokit = createOctokitForInstallation(this.appId, this.privateKey, installationId);

      const { data } = await octokit.rest.repos.getContent({
        owner,
        repo,
        path: this.allowedUsersPath,
        mediaType: { format: 'raw' },
      });

      // getContent is typed as a union (file/dir/symlink/submodule); the raw
      // media type gives back the file contents as a string.
      const content: unknown = data;
      if (typeof content !== 'string') {
        throw new TypeError(`Expected file contents at ${this.allowedUsersPath}`);
      }

      const parsed: unknown = JSON.parse(content);
      if (!Array.isArray(parsed)) {
        throw new TypeError(`Expected an array of users at ${this.allowedUsersPath}`);
      }

      // Entries without a numeric GitHub id can never match a reviewer, and
      // would throw when compared against one, so drop them here rather than
      // guarding at every use site.
      const users = parsed.filter(
        (user): user is User =>
          typeof user === 'object' && user !== null && typeof (user as User).github?.id === 'number',
      );

      if (users.length !== parsed.length) {
        console.log(`[approval] Ignored ${parsed.length - users.length} user entries without a GitHub id`);
      }

      // Update cache
      this.allowedUsersCache = {
        users,
        fetchedAt: Date.now(),
      };

      return users;
    } catch (error) {
      console.log(`[approval] Failed to fetch allowed users from ${this.allowedUsersRepo}:`, error);

      // If we have cached data, use it even if expired
      if (this.allowedUsersCache) {
        console.log('[approval] Using cached allowed users due to fetch error');
        return this.allowedUsersCache.users;
      }

      // Default to empty list if no cache and fetch failed, so an unreadable
      // allowlist fails closed rather than approving.
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

      const reviews = await octokit.paginate(octokit.rest.pulls.listReviews, {
        owner,
        repo,
        pull_number: prNumber,
        per_page: 100,
      });

      console.log(`[approval] Fetched ${reviews.length} total reviews for PR #${prNumber}`);

      return reviews as Review[];
    } catch (error) {
      console.log(`[approval] Failed to fetch reviews for PR #${prNumber}: ${error}`);
      return [];
    }
  }

  /**
   * Check if a specific user is authorized to approve
   */
  isUserAuthorized(userId: number, users: User[]): boolean {
    return users.some((user) => user.github.id === userId && hasApproverRole(user));
  }
}
