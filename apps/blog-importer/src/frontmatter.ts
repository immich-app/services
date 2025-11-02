import matter from 'gray-matter';
import type { OutlineDocument, PostFrontmatter } from './types.js';

/**
 * Slugify a string by converting to lowercase, removing special chars,
 * and replacing spaces with hyphens.
 */
export function slugify(text: string): string {
  let slug = text.toLowerCase().trim();
  slug = slug.replace(/[^\w\s-]/g, '');
  slug = slug.replace(/[-\s]+/g, '-');
  return slug.replace(/^-+|-+$/g, '');
}

/**
 * Parse markdown text with frontmatter.
 * Returns the frontmatter data and the content.
 */
export function parseFrontmatter(text: string): {
  data: Record<string, unknown>;
  content: string;
} {
  const parsed = matter(text);
  return {
    data: parsed.data,
    content: parsed.content,
  };
}

/**
 * Update frontmatter with post metadata from Outline.
 */
export function updateFrontmatter(
  existingData: Record<string, unknown>,
  document: OutlineDocument,
  slug?: string,
): PostFrontmatter {
  const today = new Date().toISOString().split('T')[0];
  const finalSlug = slug || (existingData.slug as string) || slugify(document.title);

  return {
    ...existingData,
    id: document.id,
    title: document.title,
    publishedAt: today,
    authors: ['Immich Team'],
    slug: finalSlug,
  } as PostFrontmatter;
}

/**
 * Serialize frontmatter and content back to markdown.
 */
export function serializeFrontmatter(data: PostFrontmatter, content: string): string {
  return matter.stringify(content, data);
}
