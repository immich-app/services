import { SemVer, gte } from 'semver';
import type { IMetricsRepository } from './metrics.js';
import type { IReleaseRepository } from './release-repository.js';
import type { DocsVersion } from './types.js';

const FIRST_ARCHIVED = new SemVer('1.100.0');
const FIRST_DOCS_SUBDOMAIN = new SemVer('1.143.1');

export class DocsService {
  constructor(
    private releaseRepository: IReleaseRepository,
    private metrics: IMetricsRepository,
  ) {}

  async getArchivedVersions(): Promise<DocsVersion[]> {
    const versions = await this.metrics.monitorAsyncFunction({ name: 'd1_get_docs_versions' }, () =>
      this.releaseRepository.getLatestPatchPerMinor(FIRST_ARCHIVED),
    )();

    return versions.map((version) => toDocsVersion(version));
  }
}

function toDocsVersion(version: SemVer): DocsVersion {
  const label = `v${version.version}`;

  if (gte(version, FIRST_DOCS_SUBDOMAIN)) {
    return { label, url: `https://docs.${label}.archive.immich.app` };
  }

  return { label, url: `https://${label}.archive.immich.app`, rootPath: '/docs' };
}
