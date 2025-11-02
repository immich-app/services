// Outline webhook event types
export interface OutlineWebhookEvent {
  event: string;
  payload: {
    model: OutlineDocument;
    modelId: string;
  };
  createdAt: string;
}

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

// Image processing types
export interface ImageProcessingResult {
  webpData: ArrayBuffer;
  contentHash: string;
}
