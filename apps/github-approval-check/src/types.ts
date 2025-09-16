/**
 * GitHub webhook event type definitions
 */

export interface Repository {
  id: number;
  name: string;
  full_name: string;
  owner: {
    login: string;
    id: number;
  };
}

export interface Installation {
  id: number;
  account: {
    login: string;
    id: number;
  };
}

export interface PullRequest {
  id: number;
  number: number;
  state: 'open' | 'closed';
  title: string;
  head: {
    sha: string;
    ref: string;
  };
  base: {
    sha: string;
    ref: string;
  };
}

export interface PullRequestEvent {
  action: 'opened' | 'closed' | 'reopened' | 'synchronize' | 'edited';
  number: number;
  pull_request: PullRequest;
  repository: Repository;
  installation: Installation;
}

export interface Review {
  id: number;
  user: {
    login: string;
    id: number;
  };
  state: 'approved' | 'changes_requested' | 'commented' | 'dismissed' | 'pending';
  submitted_at: string;
  body: string;
}

export interface PullRequestReviewEvent {
  action: 'submitted' | 'edited' | 'dismissed';
  review: Review;
  pull_request: PullRequest;
  repository: Repository;
  installation: Installation;
}

export interface CheckSuite {
  id: number;
  head_sha: string;
  head_branch: string;
  status: 'queued' | 'in_progress' | 'completed';
  conclusion: 'success' | 'failure' | 'neutral' | 'cancelled' | 'skipped' | 'timed_out' | 'action_required' | null;
  pull_requests: Array<{
    id: number;
    number: number;
    head: {
      sha: string;
    };
  }>;
}

export interface CheckSuiteEvent {
  action: 'requested' | 'rerequested' | 'completed';
  check_suite: CheckSuite;
  repository: Repository;
  installation: Installation;
}

export interface CheckRun {
  id: number;
  name: string;
  head_sha: string;
  status: 'queued' | 'in_progress' | 'completed';
  conclusion: 'success' | 'failure' | 'neutral' | 'cancelled' | 'skipped' | 'timed_out' | 'action_required' | null;
  started_at: string;
  completed_at: string | null;
  pull_requests: Array<{
    id: number;
    number: number;
    head: {
      sha: string;
    };
  }>;
}

export interface CheckRunEvent {
  action: 'created' | 'completed' | 'rerequested' | 'requested_action';
  check_run: CheckRun;
  repository: Repository;
  installation: Installation;
}
