// Outline webhook event types
export interface OutlineWebhookEvent {
  event: string;
  payload: {
    model: OutlineDocument;
    modelId: string;
  };
  createdAt: string;
}

// CLAUDE: I think you're missing a nesting level here. Based on the python script it's payload.model.data.text etc
export interface OutlineDocument {
  id: string;
  title: string;
  text: string;
  createdAt: string;
  updatedAt: string;
  publishedAt?: string;
}

// Frontmatter structure
export interface PostFrontmatter {
  id: string;
  title: string;
  description: string;
  publishedAt: string;
  authors: string[];
  slug: string;
  [key: string]: unknown;
}

// GitHub API types
export interface GitHubTreeItem {
  path: string;
  mode: '100644' | '100755' | '040000' | '160000' | '120000';
  type: 'blob' | 'tree' | 'commit';
  content?: string;
}

export interface GitHubCreateTreeResponse {
  sha: string;
  url: string;
}

export interface GitHubCreateCommitResponse {
  sha: string;
  url: string;
}

export interface GitHubRef {
  ref: string;
  object: {
    sha: string;
    type: string;
  };
}

export interface GitHubPullRequest {
  number: number;
  html_url: string;
  state: 'open' | 'closed';
}

// Image processing types
export interface ImageProcessingResult {
  webpData: ArrayBuffer;
  contentHash: string;
}
