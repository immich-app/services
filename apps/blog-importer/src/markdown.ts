import { remark } from 'remark';
import remarkFrontmatter from 'remark-frontmatter';
import { visit } from 'unist-util-visit';
import type { Image, Root } from 'mdast';

export interface ImageReplacement {
  originalUrl: string;
  newUrl: string;
}

/**
 * Process markdown content and replace image URLs.
 * Returns the updated markdown and a list of images that were found.
 *
 * @param markdown The markdown content to process
 * @param replacementFn Function to transform image URLs. Receives the original URL,
 *                      returns the new URL or undefined to skip replacement.
 */
export async function processMarkdownImages(
  markdown: string,
  replacementFn: (url: string) => Promise<string | undefined>,
): Promise<{ markdown: string; replacements: ImageReplacement[] }> {
  const replacements: ImageReplacement[] = [];

  // Parse markdown to AST
  const processor = remark().use(remarkFrontmatter, ['yaml']);
  const tree = processor.parse(markdown) as Root;

  // Find all image nodes and collect URLs
  const imageNodes: Image[] = [];
  visit(tree, 'image', (node: Image) => {
    imageNodes.push(node);
  });

  // Process each image
  for (const node of imageNodes) {
    const originalUrl = node.url;
    const newUrl = await replacementFn(originalUrl);

    if (newUrl) {
      node.url = newUrl;
      replacements.push({ originalUrl, newUrl });
    }
  }

  // Convert AST back to markdown
  const updatedMarkdown = processor.stringify(tree);

  return {
    markdown: updatedMarkdown,
    replacements,
  };
}

/**
 * Convert a potentially relative URL to an absolute URL using a base URL.
 */
export function resolveImageUrl(imageUrl: string, baseUrl: string): string {
  // Already absolute
  if (imageUrl.startsWith('http://') || imageUrl.startsWith('https://')) {
    return imageUrl;
  }

  // Relative URL - resolve against base
  const base = new URL(baseUrl);
  return new URL(imageUrl, base.origin).toString();
}
