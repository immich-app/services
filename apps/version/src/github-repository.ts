import semver from 'semver';
import type { GitHubRelease } from './types.js';

const GITHUB_RELEASES_URL = 'https://api.github.com/repos/immich-app/immich/releases';
const MAX_PAGES = 3;
const PER_PAGE = 100;

export class GitHubRateLimitError extends Error {
  constructor(public retryAfter: string | null) {
    super('GitHub API rate limit exceeded');
    this.name = 'GitHubRateLimitError';
  }
}

export interface IGitHubRepository {
  readonly rateLimitRemaining?: number;
  fetchLatestRelease(): Promise<GitHubRelease | null>;
  fetchReleases(): Promise<GitHubRelease[]>;
}

export class GitHubRepository implements IGitHubRepository {
  rateLimitRemaining?: number;

  constructor(private githubToken?: string) {}

  async fetchLatestRelease(): Promise<GitHubRelease | null> {
    const headers = this.buildHeaders();
    const response = await fetch(`${GITHUB_RELEASES_URL}/latest`, { headers });
    this.captureRateLimit(response);

    if (!response.ok) {
      handleErrorResponse(response);
    }

    const data = (await response.json()) as unknown;
    return parseRelease(data);
  }

  async fetchReleases(): Promise<GitHubRelease[]> {
    const headers = this.buildHeaders();
    const allReleases: GitHubRelease[] = [];

    for (let page = 1; page <= MAX_PAGES; page++) {
      const url = `${GITHUB_RELEASES_URL}?per_page=${PER_PAGE}&page=${page}`;
      const response = await fetch(url, { headers });
      this.captureRateLimit(response);

      if (!response.ok) {
        handleErrorResponse(response);
      }

      const pageReleases = (await response.json()) as unknown[];
      for (const item of pageReleases) {
        const release = parseRelease(item);
        if (release) {
          allReleases.push(release);
        }
      }

      if (pageReleases.length < PER_PAGE) {
        break;
      }
    }

    allReleases.sort((a, b) => {
      const semverA = semver.parse(a.tag_name);
      const semverB = semver.parse(b.tag_name);
      if (!semverA || !semverB) {
        return 0;
      }
      return semver.compare(semverB, semverA);
    });

    return allReleases;
  }

  private captureRateLimit(response: Response) {
    const header = response.headers.get('X-RateLimit-Remaining');
    if (header === null) {
      return;
    }
    const remaining = Number(header);
    if (Number.isFinite(remaining)) {
      this.rateLimitRemaining = remaining;
    }
  }

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'immich-version-worker',
    };

    if (this.githubToken) {
      headers.Authorization = `Bearer ${this.githubToken}`;
    }

    return headers;
  }
}

function handleErrorResponse(response: Response): never {
  const isRateLimit =
    response.status === 429 || (response.status === 403 && response.headers.get('X-RateLimit-Remaining') === '0');

  if (isRateLimit) {
    const retryAfter = response.headers.get('Retry-After') ?? response.headers.get('X-RateLimit-Reset');
    console.error(`[version] GitHub rate limit exceeded. Retry-After: ${retryAfter}`);
    throw new GitHubRateLimitError(retryAfter);
  }

  throw new Error(`GitHub API error: ${response.status} ${response.statusText}`);
}

function isValidRelease(data: unknown): data is Record<string, unknown> & { id: number; tag_name: string } {
  if (typeof data !== 'object' || data === null) {
    return false;
  }
  const obj = data as Record<string, unknown>;
  return typeof obj.id === 'number' && typeof obj.tag_name === 'string';
}

function parseRelease(item: unknown): GitHubRelease | null {
  if (!isValidRelease(item)) {
    return null;
  }
  // Drafts are skipped, but pre-releases (rc builds) are kept to back the `rc` channel.
  if (item.draft === true) {
    return null;
  }

  return {
    id: item.id,
    url: String(item.url ?? ''),
    tag_name: item.tag_name,
    name: String(item.name ?? ''),
    created_at: String(item.created_at ?? ''),
    published_at: String(item.published_at ?? ''),
    body: String(item.body ?? ''),
  };
}
