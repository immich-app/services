import { SignJWT, importPKCS8 } from 'jose';
import type {
  GitHubCreateCommitResponse,
  GitHubCreateTreeResponse,
  GitHubPullRequest,
  GitHubRef,
  GitHubTreeItem,
} from './types.js';

const GITHUB_API_BASE = 'https://api.github.com';
const GITHUB_REPO = 'immich-app/static-pages';
const GITHUB_BASE_BRANCH = 'main';

/**
 * Generate a JWT for GitHub App authentication.
 */
async function generateGitHubAppJWT(appId: string, privateKey: string): Promise<string> {
  // Parse the private key
  const key = await importPKCS8(privateKey, 'RS256');

  // Create JWT
  const jwt = await new SignJWT({})
    .setProtectedHeader({ alg: 'RS256' })
    .setIssuedAt()
    .setIssuer(appId)
    .setExpirationTime('10m')
    .sign(key);

  return jwt;
}

/**
 * Get an installation access token for the GitHub App.
 */
async function getInstallationToken(
  appId: string,
  privateKey: string,
  installationId: string,
): Promise<string> {
  const jwt = await generateGitHubAppJWT(appId, privateKey);

  const response = await fetch(
    `${GITHUB_API_BASE}/app/installations/${installationId}/access_tokens`,
    {
      method: 'POST',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${jwt}`,
      },
    },
  );

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to get installation token: ${response.status} ${error}`);
  }

  const data = (await response.json()) as { token: string };
  return data.token;
}

// CLAUDE: Use octokit, wtf
/**
 * GitHub API client with authentication.
 */
export class GitHubClient {
  private token: string | null = null;

  constructor(
    private appId: string,
    private privateKey: string,
    private installationId: string,
  ) {}

  /**
   * Ensure we have a valid token.
   */
  private async ensureToken(): Promise<string> {
    if (!this.token) {
      this.token = await getInstallationToken(this.appId, this.privateKey, this.installationId);
    }
    return this.token;
  }

  /**
   * Make an authenticated GitHub API request.
   */
  private async request<T>(
    path: string,
    options?: RequestInit,
  ): Promise<T> {
    const token = await this.ensureToken();
    const url = `${GITHUB_API_BASE}${path}`;

    const response = await fetch(url, {
      ...options,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...options?.headers,
      },
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`GitHub API error: ${response.status} ${error} (${path})`);
    }

    return response.json() as Promise<T>;
  }

  /**
   * Get a reference (branch or tag).
   */
  async getRef(ref: string): Promise<GitHubRef | null> {
    try {
      return await this.request<GitHubRef>(`/repos/${GITHUB_REPO}/git/ref/${ref}`);
    } catch (error) {
      // 404 means ref doesn't exist
      if (error instanceof Error && error.message.includes('404')) {
        return null;
      }
      throw error;
    }
  }

  /**
   * Create or update a reference.
   */
  async createOrUpdateRef(ref: string, sha: string): Promise<void> {
    // CLAUDE: Instead of a separate get, just try to create and catch 422 error?
    const existingRef = await this.getRef(ref);

    // eslint-disable-next-line unicorn/prefer-ternary
    if (existingRef) {
      // Update existing ref (force push)
      await this.request(`/repos/${GITHUB_REPO}/git/refs/${ref}`, {
        method: 'PATCH',
        body: JSON.stringify({ sha, force: true }),
      });
    } else {
      // Create new ref
      await this.request(`/repos/${GITHUB_REPO}/git/refs`, {
        method: 'POST',
        body: JSON.stringify({ ref: `refs/${ref}`, sha }),
      });
    }
  }

  // CLAUDE: Do these calls properly handle an object already existing?
  /**
   * Create a tree (represents a directory structure).
   */
  async createTree(
    baseTreeSha: string,
    files: GitHubTreeItem[],
  ): Promise<GitHubCreateTreeResponse> {
    return this.request<GitHubCreateTreeResponse>(`/repos/${GITHUB_REPO}/git/trees`, {
      method: 'POST',
      body: JSON.stringify({
        base_tree: baseTreeSha,
        tree: files,
      }),
    });
  }

  /**
   * Create a commit.
   */
  async createCommit(
    message: string,
    treeSha: string,
    parentSha: string,
  ): Promise<GitHubCreateCommitResponse> {
    return this.request<GitHubCreateCommitResponse>(`/repos/${GITHUB_REPO}/git/commits`, {
      method: 'POST',
      body: JSON.stringify({
        message,
        tree: treeSha,
        parents: [parentSha],
      }),
    });
  }

  /**
   * Find an existing PR for a branch.
   */
  async findPullRequest(headBranch: string): Promise<GitHubPullRequest | null> {
    const prs = await this.request<GitHubPullRequest[]>(
      `/repos/${GITHUB_REPO}/pulls?state=open&head=immich-app:${headBranch}`,
    );
    return prs.length > 0 ? prs[0] : null;
  }

  /**
   * Create a pull request.
   */
  async createPullRequest(
    title: string,
    headBranch: string,
    body: string,
  ): Promise<GitHubPullRequest> {
    return this.request<GitHubPullRequest>(`/repos/${GITHUB_REPO}/pulls`, {
      method: 'POST',
      body: JSON.stringify({
        title,
        head: headBranch,
        base: GITHUB_BASE_BRANCH,
        body,
      }),
    });
  }

  /**
   * Commit a file to a branch and create a PR.
   * If the branch/PR already exists, it will be force-updated.
   */
  async commitAndCreatePR(
    branchName: string,
    filePath: string,
    fileContent: string,
    commitMessage: string,
    prTitle: string,
  ): Promise<{ prUrl: string; prNumber: number }> {
    // Get the current main branch SHA
    const mainRef = await this.getRef(`heads/${GITHUB_BASE_BRANCH}`);
    if (!mainRef) {
      throw new Error(`Base branch ${GITHUB_BASE_BRANCH} not found`);
    }
    const baseSha = mainRef.object.sha;

    // Create a tree with the new file
    const tree = await this.createTree(baseSha, [
      {
        path: filePath,
        mode: '100644',
        type: 'blob',
        content: fileContent,
      },
    ]);

    // Create a commit
    const commit = await this.createCommit(commitMessage, tree.sha, baseSha);

    // Create or update the branch
    await this.createOrUpdateRef(`heads/${branchName}`, commit.sha);

    // Check if PR already exists
    const existingPR = await this.findPullRequest(branchName);

    if (existingPR) {
      // PR exists and branch was force-updated, return existing PR
      return {
        prUrl: existingPR.html_url,
        prNumber: existingPR.number,
      };
    }

    // Create new PR
    const pr = await this.createPullRequest(prTitle, branchName, commitMessage);

    return {
      prUrl: pr.html_url,
      prNumber: pr.number,
    };
  }
}
