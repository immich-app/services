import { parse, type SemVer } from 'semver';
import type { GitHubRelease } from './types.js';

interface ReleaseRow {
  id: number;
  tag_name: string;
  name: string;
  url: string;
  body: string;
  created_at: string;
  published_at: string;
}

export const releaseChannels = ['stable', 'rc'] as const;
export type ReleaseChannel = (typeof releaseChannels)[number];

export interface IReleaseRepository {
  getLatest(channel?: ReleaseChannel): Promise<GitHubRelease | null>;
  getNewerThan(version: SemVer, channel?: ReleaseChannel): Promise<GitHubRelease[]>;
  getCount(): Promise<number>;
  upsert(release: GitHubRelease): Promise<void>;
  bulkUpsert(releases: GitHubRelease[]): Promise<void>;
}

export class ReleaseRepository implements IReleaseRepository {
  constructor(private db: D1Database) {}

  async getLatest(channel: ReleaseChannel = 'stable'): Promise<GitHubRelease | null> {
    // The `rc` channel sees every release; `stable` only sees rows without a prerelease component.
    // Within the same major.minor.patch a stable release outranks its own pre-releases (1.0.0 > 1.0.0-rc.1),
    // so order stable (prerelease IS NULL) ahead of pre-releases before falling back to the prerelease number.
    const row = await this.db
      .prepare(
        `SELECT id, tag_name, name, url, body, created_at, published_at FROM releases
         WHERE ?1 = 'rc' OR prerelease IS NULL
         ORDER BY major DESC, minor DESC, patch DESC, (prerelease IS NULL) DESC, prerelease DESC
         LIMIT 1`,
      )
      .bind(channel)
      .first<ReleaseRow>();

    return row ? toGitHubRelease(row) : null;
  }

  async getCount(): Promise<number> {
    const row = await this.db.prepare('SELECT COUNT(*) as count FROM releases').first<{ count: number }>();
    return row?.count ?? 0;
  }

  async getNewerThan(version: SemVer, channel: ReleaseChannel = 'stable'): Promise<GitHubRelease[]> {
    // `version.prerelease` is an array (e.g. ['rc', 1] for v1.0.0-rc.1); bind only the numeric
    // component to match the `prerelease` column. Binding the array itself throws D1_TYPE_ERROR.
    const prerelease = version.prerelease[1] ?? null;
    const { results } = await this.db
      .prepare(
        `SELECT id, tag_name, name, url, body, created_at, published_at FROM releases
         WHERE (?5 = 'rc' OR prerelease IS NULL)
           AND (
             major > ?1
             OR (major = ?1 AND minor > ?2)
             OR (major = ?1 AND minor = ?2 AND patch > ?3)
             OR (major = ?1 AND minor = ?2 AND patch = ?3 AND ?4 IS NOT NULL AND (prerelease IS NULL OR prerelease > ?4))
           )
         ORDER BY major DESC, minor DESC, patch DESC, (prerelease IS NULL) DESC, prerelease DESC`,
      )
      .bind(version.major, version.minor, version.patch, prerelease, channel)
      .all<ReleaseRow>();

    return results.map((row) => toGitHubRelease(row));
  }

  async upsert(release: GitHubRelease): Promise<void> {
    const semver = parse(release.tag_name);
    if (!semver) {
      return;
    }

    await this.db
      .prepare(
        `INSERT OR REPLACE INTO releases (id, tag_name, name, url, body, created_at, published_at, major, minor, patch, prerelease)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`,
      )
      .bind(
        release.id,
        release.tag_name,
        release.name,
        release.url,
        release.body,
        release.created_at,
        release.published_at,
        semver.major,
        semver.minor,
        semver.patch,
        semver.prerelease[1] ?? null,
      )
      .run();
  }

  async bulkUpsert(releases: GitHubRelease[]): Promise<void> {
    const statements: D1PreparedStatement[] = [];

    for (const release of releases) {
      const semver = parse(release.tag_name);
      if (!semver) {
        continue;
      }

      statements.push(
        this.db
          .prepare(
            `INSERT OR REPLACE INTO releases (id, tag_name, name, url, body, created_at, published_at, major, minor, patch, prerelease)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`,
          )
          .bind(
            release.id,
            release.tag_name,
            release.name,
            release.url,
            release.body,
            release.created_at,
            release.published_at,
            semver.major,
            semver.minor,
            semver.patch,
            semver.prerelease[1] ?? null,
          ),
      );
    }

    if (statements.length > 0) {
      await this.db.batch(statements);
    }
  }
}

function toGitHubRelease(row: ReleaseRow): GitHubRelease {
  return {
    id: row.id,
    tag_name: row.tag_name,
    name: row.name,
    url: row.url,
    body: row.body,
    created_at: row.created_at,
    published_at: row.published_at,
  };
}
