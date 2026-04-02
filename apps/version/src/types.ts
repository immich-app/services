export interface GitHubRelease {
  id: number;
  url: string;
  tag_name: string;
  name: string;
  created_at: string;
  published_at: string;
  body: string;
}

export interface ChangelogResponse {
  current: string;
  latest: GitHubRelease | null;
  releases: GitHubRelease[];
}

export interface VersionResponse {
  version: string;
  published_at: string;
}
