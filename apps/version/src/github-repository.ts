import type { GitHubRelease } from './types.js';
import { compareSemVer, parseSemVer } from './version.js';

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
  fetchLatestRelease(): Promise<GitHubRelease | null>;
  fetchReleases(): Promise<GitHubRelease[]>;
}

export class GitHubRepository implements IGitHubRepository {
  constructor(private githubToken?: string) {}

  async fetchLatestRelease(): Promise<GitHubRelease | null> {
    const headers = this.buildHeaders();
    const response = await fetch(`${GITHUB_RELEASES_URL}/latest`, { headers });

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
      const semverA = parseSemVer(a.tag_name);
      const semverB = parseSemVer(b.tag_name);
      if (!semverA || !semverB) {
        return 0;
      }
      return compareSemVer(semverB, semverA);
    });

    return allReleases;
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
  if (item.draft === true || item.prerelease === true) {
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
