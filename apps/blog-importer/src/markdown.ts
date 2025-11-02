import type { Image, Root } from 'mdast';
import { remark } from 'remark';
import remarkFrontmatter from 'remark-frontmatter';
import { visit } from 'unist-util-visit';

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

  // TODO: Maybe support different fences so we can easily enter them in outline?
  // https://github.com/remarkjs/remark-frontmatter#example-different-markers-and-fences
  const processor = remark().use(remarkFrontmatter, ['yaml']);
  const tree = processor.parse(markdown) as Root;

  const imageNodes: Image[] = [];
  visit(tree, 'image', (node: Image) => {
    imageNodes.push(node);
  });

  for (const node of imageNodes) {
    const originalUrl = node.url;
    const newUrl = await replacementFn(originalUrl);

    if (newUrl) {
      node.url = newUrl;
      replacements.push({ originalUrl, newUrl });
    }
  }

  const updatedMarkdown = processor.stringify(tree);

  return {
    markdown: updatedMarkdown,
    replacements,
  };
}
