import { describe, expect, it } from 'vitest';
import { processMarkdownImages, resolveImageUrl } from './markdown.js';

describe('resolveImageUrl', () => {
  it('returns absolute URLs unchanged', () => {
    const url = 'https://example.com/image.png';
    expect(resolveImageUrl(url, 'https://base.com')).toBe(url);
  });

  it('resolves relative URLs against base URL', () => {
    const result = resolveImageUrl('/images/photo.jpg', 'https://outline.example.com/doc/123');
    expect(result).toBe('https://outline.example.com/images/photo.jpg');
  });

  it('handles base URLs with paths', () => {
    const result = resolveImageUrl('/api/image.png', 'https://app.getoutline.com/s/guide/doc/123');
    expect(result).toBe('https://app.getoutline.com/api/image.png');
  });
});

describe('processMarkdownImages', () => {
  it('finds and replaces image URLs', async () => {
    const markdown = `# Hello

This is a test with an image:

![Alt text](https://example.com/old-image.png)

And some more content.`;

    const result = await processMarkdownImages(markdown, async (url) => {
      if (url === 'https://example.com/old-image.png') {
        return 'https://cdn.example.com/new-image.webp';
      }
      return;
    });

    expect(result.markdown).toContain('https://cdn.example.com/new-image.webp');
    expect(result.markdown).not.toContain('old-image.png');
    expect(result.replacements).toHaveLength(1);
    expect(result.replacements[0]).toEqual({
      originalUrl: 'https://example.com/old-image.png',
      newUrl: 'https://cdn.example.com/new-image.webp',
    });
  });

  it('handles multiple images', async () => {
    const markdown = `# Gallery

![Image 1](https://example.com/img1.jpg)

Some text here.

![Image 2](https://example.com/img2.png)

![Image 3](https://example.com/img3.gif)`;

    const result = await processMarkdownImages(markdown, async (url) => {
      return url.replace('example.com', 'cdn.example.com').replace(/\.(jpg|png|gif)$/, '.webp');
    });

    expect(result.replacements).toHaveLength(3);
    expect(result.markdown).toContain('cdn.example.com/img1.webp');
    expect(result.markdown).toContain('cdn.example.com/img2.webp');
    expect(result.markdown).toContain('cdn.example.com/img3.webp');
  });

  it('preserves alt text', async () => {
    const markdown = '![Important description](https://example.com/image.png)';

    const result = await processMarkdownImages(markdown, async () => {
      return 'https://cdn.example.com/new.webp';
    });

    expect(result.markdown).toContain('![Important description]');
  });

  it('preserves non-image content', async () => {
    const markdown = `# Title

This is a paragraph with **bold** and *italic* text.

- List item 1
- List item 2

\`\`\`javascript
console.log('code block');
\`\`\`

![Image](https://example.com/image.png)

> A blockquote

[A link](https://example.com)`;

    const result = await processMarkdownImages(markdown, async () => {
      return 'https://cdn.example.com/new.webp';
    });

    expect(result.markdown).toContain('# Title');
    expect(result.markdown).toContain('**bold**');
    expect(result.markdown).toContain('*italic*');
    expect(result.markdown).toMatch(/[*-] List item 1/); // remark uses * or - for lists
    expect(result.markdown).toContain('console.log');
    expect(result.markdown).toContain('> A blockquote');
    expect(result.markdown).toContain('[A link](https://example.com)');
  });

  it('handles markdown with frontmatter', async () => {
    const markdown = `---
title: Test Post
slug: test-post
---

# Content

![Image](https://example.com/image.png)`;

    const result = await processMarkdownImages(markdown, async () => {
      return 'https://cdn.example.com/new.webp';
    });

    expect(result.markdown).toContain('---');
    expect(result.markdown).toContain('title: Test Post');
    expect(result.markdown).toContain('https://cdn.example.com/new.webp');
  });

  it('skips replacement when function returns undefined', async () => {
    const markdown = `![Image 1](https://example.com/img1.png)
![Image 2](https://example.com/img2.png)`;

    const result = await processMarkdownImages(markdown, async (url) => {
      // Only replace img1
      if (url.includes('img1')) {
        return 'https://cdn.example.com/new1.webp';
      }
      return;
    });

    expect(result.replacements).toHaveLength(1);
    expect(result.markdown).toContain('https://cdn.example.com/new1.webp');
    expect(result.markdown).toContain('https://example.com/img2.png');
  });

  it('handles empty markdown', async () => {
    const result = await processMarkdownImages('', async () => {
      return 'https://cdn.example.com/new.webp';
    });

    expect(result.markdown).toBe('');
    expect(result.replacements).toHaveLength(0);
  });

  it('handles markdown with no images', async () => {
    const markdown = `# Just text

No images here, just text and [links](https://example.com).`;

    const result = await processMarkdownImages(markdown, async () => {
      return 'https://cdn.example.com/new.webp';
    });

    expect(result.markdown).toContain('# Just text');
    expect(result.replacements).toHaveLength(0);
  });

  it('does not process reference-style images', async () => {
    const markdown = `![Alt text][image-ref]

[image-ref]: https://example.com/image.png "Image title"`;

    const result = await processMarkdownImages(markdown, async () => {
      return 'https://cdn.example.com/new.webp';
    });

    // Reference-style images use a different AST node type (definition)
    // and are not processed as regular images
    expect(result.replacements).toHaveLength(0);
    expect(result.markdown).toContain('https://example.com/image.png');
    expect(result.markdown).not.toContain('https://cdn.example.com/new.webp');
  });

  it('handles images with titles', async () => {
    const markdown = '![Alt](https://example.com/image.png "Image Title")';

    const result = await processMarkdownImages(markdown, async () => {
      return 'https://cdn.example.com/new.webp';
    });

    expect(result.markdown).toContain('https://cdn.example.com/new.webp');
  });
});
