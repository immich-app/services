import { App, Octokit } from 'octokit';
import type { GitHubTreeItem } from './types.js';

const GITHUB_REPO = 'immich-app/static-pages';
const GITHUB_BASE_BRANCH = 'main';
const [GITHUB_OWNER, GITHUB_REPO_NAME] = GITHUB_REPO.split('/');

export class GitHubClient {
  private app: App;
  private octokit: Octokit | null = null;

  constructor(
    appId: string,
    privateKey: string,
    private installationId: string,
  ) {
    this.app = new App({
      appId,
      privateKey,
    });
  }

  private async getOctokit(): Promise<Octokit> {
    if (!this.octokit) {
      this.octokit = await this.app.getInstallationOctokit(Number.parseInt(this.installationId));
    }
    return this.octokit;
  }

  async getRef(ref: string): Promise<{ sha: string } | null> {
    const octokit = await this.getOctokit();
    try {
      const { data } = await octokit.rest.git.getRef({
        owner: GITHUB_OWNER,
        repo: GITHUB_REPO_NAME,
        ref,
      });
      return { sha: data.object.sha };
    } catch (error) {
      // @ts-expect-error - Octokit error type
      if (error.status === 404) {
        return null;
      }
      throw error;
    }
  }

  async createOrUpdateRef(ref: string, sha: string): Promise<void> {
    const octokit = await this.getOctokit();

    try {
      // Try to create the ref first
      await octokit.rest.git.createRef({
        owner: GITHUB_OWNER,
        repo: GITHUB_REPO_NAME,
        ref: `refs/${ref}`,
        sha,
      });
    } catch (error) {
      // @ts-expect-error - Octokit error type
      if (error.status === 422) {
        // Ref already exists, update it (force push)
        await octokit.rest.git.updateRef({
          owner: GITHUB_OWNER,
          repo: GITHUB_REPO_NAME,
          ref,
          sha,
          force: true,
        });
      } else {
        throw error;
      }
    }
  }

  async createTree(baseTreeSha: string, files: GitHubTreeItem[]): Promise<{ sha: string }> {
    const octokit = await this.getOctokit();
    const { data } = await octokit.rest.git.createTree({
      owner: GITHUB_OWNER,
      repo: GITHUB_REPO_NAME,
      base_tree: baseTreeSha,
      tree: files,
    });
    return { sha: data.sha };
  }

  async createCommit(message: string, treeSha: string, parentSha: string): Promise<{ sha: string }> {
    const octokit = await this.getOctokit();
    const { data } = await octokit.rest.git.createCommit({
      owner: GITHUB_OWNER,
      repo: GITHUB_REPO_NAME,
      message,
      tree: treeSha,
      parents: [parentSha],
    });
    return { sha: data.sha };
  }

  async findPullRequest(headBranch: string): Promise<{ number: number; html_url: string } | null> {
    const octokit = await this.getOctokit();
    const { data } = await octokit.rest.pulls.list({
      owner: GITHUB_OWNER,
      repo: GITHUB_REPO_NAME,
      state: 'open',
      head: `${GITHUB_OWNER}:${headBranch}`,
    });
    if (data.length === 0) {
      return null;
    }
    return {
      number: data[0].number,
      html_url: data[0].html_url,
    };
  }

  async createPullRequest(
    title: string,
    headBranch: string,
    body: string,
  ): Promise<{ number: number; html_url: string }> {
    const octokit = await this.getOctokit();
    const { data } = await octokit.rest.pulls.create({
      owner: GITHUB_OWNER,
      repo: GITHUB_REPO_NAME,
      title,
      head: headBranch,
      base: GITHUB_BASE_BRANCH,
      body,
    });
    return {
      number: data.number,
      html_url: data.html_url,
    };
  }

  async commitAndCreatePR(
    branchName: string,
    filePath: string,
    fileContent: string,
    commitMessage: string,
  ): Promise<{ prUrl: string; prNumber: number }> {
    const mainRef = await this.getRef(`heads/${GITHUB_BASE_BRANCH}`);
    if (!mainRef) {
      throw new Error(`Base branch ${GITHUB_BASE_BRANCH} not found`);
    }

    const tree = await this.createTree(mainRef.sha, [
      {
        path: filePath,
        mode: '100644',
        type: 'blob',
        content: fileContent,
      },
    ]);

    const commit = await this.createCommit(commitMessage, tree.sha, mainRef.sha);
    await this.createOrUpdateRef(`heads/${branchName}`, commit.sha);

    const existingPR = await this.findPullRequest(branchName);
    if (existingPR) {
      return {
        prUrl: existingPR.html_url,
        prNumber: existingPR.number,
      };
    }

    const pr = await this.createPullRequest(commitMessage, branchName, commitMessage);
    return {
      prUrl: pr.html_url,
      prNumber: pr.number,
    };
  }
}
