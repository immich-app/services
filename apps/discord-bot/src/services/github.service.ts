import type { IGithubInterface, PullRequestBaseEvent } from '../interfaces/github.interface.js';

export class GithubService {
  constructor(private repository: IGithubInterface) {}

  async getOpenPullRequests() {
    const pullRequests: PullRequestBaseEvent[] = [];

    for await (const batch of this.repository.getPullRequests(
      { org: 'immich-app', repo: 'immich' },
      { states: ['OPEN'] },
    )) {
      pullRequests.push(
        ...batch.map(({ repository, author, fullDatabaseId, url, ...pr }) => ({
          pull_request: {
            ...pr,
            id: Number(fullDatabaseId),
            html_url: url,
          },
          repository: { full_name: repository.nameWithOwner },
          sender: { type: author.__typename },
        })),
      );
    }

    return pullRequests;
  }
}
