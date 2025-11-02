import { describe, expect, it } from 'vitest';
import {
  parseFrontmatter,
  serializeFrontmatter,
  slugify,
  updateFrontmatter,
} from './frontmatter.js';
import type { OutlineDocument } from './types.js';

describe('slugify', () => {
  it('converts text to lowercase', () => {
    expect(slugify('Hello World')).toBe('hello-world');
  });

  it('replaces spaces with hyphens', () => {
    expect(slugify('multiple   spaces   here')).toBe('multiple-spaces-here');
  });

  it('removes special characters', () => {
    expect(slugify('Hello, World! How are you?')).toBe('hello-world-how-are-you');
  });

  it('strips leading and trailing hyphens', () => {
    expect(slugify('  -hello-world-  ')).toBe('hello-world');
  });

  it('handles underscores correctly', () => {
    expect(slugify('hello_world_test')).toBe('hello_world_test');
  });
});

describe('parseFrontmatter', () => {
  it('parses frontmatter and content', () => {
    const markdown = `---
title: Test Post
slug: test-post
---

This is the content.`;

    const result = parseFrontmatter(markdown);
    expect(result.data).toEqual({
      title: 'Test Post',
      slug: 'test-post',
    });
    expect(result.content.trim()).toBe('This is the content.');
  });

  it('handles empty frontmatter', () => {
    const markdown = `---
---

Content without frontmatter.`;

    const result = parseFrontmatter(markdown);
    expect(result.data).toEqual({});
    expect(result.content.trim()).toBe('Content without frontmatter.');
  });

  it('handles content without frontmatter', () => {
    const markdown = 'Just plain content';

    const result = parseFrontmatter(markdown);
    expect(result.data).toEqual({});
    expect(result.content).toBe('Just plain content');
  });
});

describe('updateFrontmatter', () => {
  const mockDocument: OutlineDocument = {
    id: 'doc-123',
    title: 'My Blog Post',
    text: '---\n---\n\nContent here',
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-02T00:00:00Z',
  };

  it('updates frontmatter with document metadata', () => {
    const result = updateFrontmatter({}, mockDocument);

    expect(result.id).toBe('doc-123');
    expect(result.title).toBe('My Blog Post');
    expect(result.authors).toEqual(['Immich Team']);
    expect(result.slug).toBe('my-blog-post');
    expect(result.publishedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('uses provided slug over generated slug', () => {
    const result = updateFrontmatter({}, mockDocument, 'custom-slug');
    expect(result.slug).toBe('custom-slug');
  });

  it('preserves existing slug if no slug argument provided', () => {
    const existingData = { slug: 'existing-slug', customField: 'value' };
    const result = updateFrontmatter(existingData, mockDocument);
    expect(result.slug).toBe('existing-slug');
  });

  it('preserves additional frontmatter fields', () => {
    const existingData = {
      customField: 'custom value',
      tags: ['tag1', 'tag2'],
    };
    const result = updateFrontmatter(existingData, mockDocument);
    expect(result.customField).toBe('custom value');
    expect(result.tags).toEqual(['tag1', 'tag2']);
  });

  it('generates slug from title when not provided', () => {
    const result = updateFrontmatter({}, mockDocument);
    expect(result.slug).toBe('my-blog-post');
  });
});

describe('serializeFrontmatter', () => {
  it('serializes frontmatter and content', () => {
    const frontmatter = {
      id: 'doc-123',
      title: 'Test Post',
      publishedAt: '2024-01-01',
      authors: ['Immich Team'],
      slug: 'test-post',
    };
    const content = 'This is the content.';

    const result = serializeFrontmatter(frontmatter, content);

    expect(result).toContain('---');
    expect(result).toContain('title: Test Post');
    expect(result).toContain('id: doc-123');
    expect(result).toContain('slug: test-post');
    expect(result).toContain('This is the content.');
  });

  it('handles arrays in frontmatter', () => {
    const frontmatter = {
      id: 'doc-123',
      title: 'Test',
      publishedAt: '2024-01-01',
      authors: ['Author 1', 'Author 2'],
      slug: 'test',
    };
    const content = 'Content';

    const result = serializeFrontmatter(frontmatter, content);

    expect(result).toContain('authors:');
    expect(result).toContain('- Author 1');
    expect(result).toContain('- Author 2');
  });
});

describe('frontmatter roundtrip', () => {
  it('can parse, update, and serialize frontmatter', () => {
    const originalMarkdown = `---
slug: original-slug
customField: custom value
---

Original content here.`;

    const mockDocument: OutlineDocument = {
      id: 'doc-456',
      title: 'Updated Title',
      text: '',
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-02T00:00:00Z',
    };

    // Parse
    const parsed = parseFrontmatter(originalMarkdown);

    // Update
    const updated = updateFrontmatter(parsed.data, mockDocument);

    // Serialize
    const serialized = serializeFrontmatter(updated, parsed.content);

    // Verify roundtrip preserved and updated fields
    const reparsed = parseFrontmatter(serialized);
    expect(reparsed.data.id).toBe('doc-456');
    expect(reparsed.data.title).toBe('Updated Title');
    expect(reparsed.data.slug).toBe('original-slug');
    expect(reparsed.data.customField).toBe('custom value');
    expect(reparsed.content.trim()).toBe('Original content here.');
  });
});
