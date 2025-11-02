import matter from 'gray-matter';
import { formatMarkdown } from './formatter.js';
import { GitHubClient } from './github.js';
import { processImage } from './images.js';
import { processMarkdownImages, resolveImageUrl } from './markdown.js';
import { clearR2Directory, uploadToR2 } from './r2.js';
import type { OutlineWebhookEvent, PostFrontmatter } from './types.js';

const BLOG_PREFIX = 'blog';
const OUTPUT_PATH_BASE = 'apps/root.immich.app/src/routes/blog';

/**
 * Slugify a string by converting to lowercase, removing special chars,
 * and replacing spaces with hyphens.
 */
function slugify(text: string): string {
  let slug = text.toLowerCase().trim();
  slug = slug.replaceAll(/[^\w\s-]/g, '');
  slug = slug.replaceAll(/[-\s]+/g, '-');
  return slug.replaceAll(/^-+|-+$/g, '');
}

/**
 * Verify Outline webhook signature using HMAC.
 */
async function verifyWebhookSignature(payload: string, signature: string, secret: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
  ]);

  const signatureBuffer = await crypto.subtle.sign('HMAC', key, encoder.encode(payload));
  const computedSignature = [...new Uint8Array(signatureBuffer)].map((b) => b.toString(16).padStart(2, '0')).join('');

  return computedSignature === signature;
}

/**
 * Process a blog post import from Outline.
 */
async function processBlogImport(event: OutlineWebhookEvent, env: Env): Promise<string> {
  const document = event.payload.model;
  console.log(`Processing document: ${document.id} - ${document.title}`);

  // Outline escapes the frontmatter delimiters, so unescape them
  const text = document.text.replaceAll(String.raw`\---`, '---');
  const { data: frontmatterData, content } = matter(text);

  const imagePrefix = `${BLOG_PREFIX}/${document.id}/`;
  const deletedCount = await clearR2Directory(env.STATIC_BUCKET, imagePrefix);
  console.log(`Cleared ${deletedCount} old images from R2`);

  const { markdown: processedMarkdown, replacements } = await processMarkdownImages(content, async (imageUrl) => {
    const absoluteUrl = resolveImageUrl(imageUrl, env.OUTLINE_BASE_URL);
    console.log(`Processing image: ${absoluteUrl}`);

    const { webpData, contentHash } = await processImage(absoluteUrl, env.OUTLINE_API_KEY);

    const r2Key = `${imagePrefix}${contentHash}.webp`;
    await uploadToR2(env.STATIC_BUCKET, r2Key, webpData, {
      contentType: 'image/webp',
    });

    const newUrl = `${env.R2_PUBLIC_URL}/${r2Key}`;
    console.log(`Replaced with: ${newUrl}`);

    return newUrl;
  });

  console.log(`Processed ${replacements.length} images`);

  const today = new Date().toISOString().split('T')[0];
  const slug = (frontmatterData.slug as string) || slugify(document.title);
  const updatedFrontmatter: PostFrontmatter = {
    ...frontmatterData,
    id: document.id,
    title: document.title,
    publishedAt: today,
    authors: ['Immich Team'],
    slug,
  } as PostFrontmatter;

  const finalMarkdown = matter.stringify(processedMarkdown, updatedFrontmatter);
  const formattedMarkdown = await formatMarkdown(finalMarkdown);

  const github = new GitHubClient(env.GITHUB_APP_ID, env.GITHUB_APP_PRIVATE_KEY, env.GITHUB_INSTALLATION_ID);

  const branchName = `blog/${document.id}`;
  const filePath = `${OUTPUT_PATH_BASE}/${updatedFrontmatter.slug}/+page.md`;
  const commitMessage = `feat: import ${updatedFrontmatter.slug}`;

  const { prUrl, prNumber } = await github.commitAndCreatePR(branchName, filePath, formattedMarkdown, commitMessage);

  console.log(`Created/updated PR #${prNumber}: ${prUrl}`);

  return prUrl;
}

/**
 * Main worker handler.
 */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/webhook' && request.method === 'POST') {
      try {
        const payload = await request.text();

        // Skip validation only if explicitly enabled for dev (set SKIP_WEBHOOK_VALIDATION=true in .dev.vars)
        if (env.SKIP_WEBHOOK_VALIDATION !== 'true') {
          const signature = request.headers.get('Outline-Signature');
          if (!signature) {
            return new Response('Missing webhook signature', { status: 401 });
          }

          const isValid = await verifyWebhookSignature(payload, signature, env.OUTLINE_WEBHOOK_SECRET);

          if (!isValid) {
            return new Response('Invalid webhook signature', { status: 401 });
          }
        }

        const event = JSON.parse(payload) as OutlineWebhookEvent;

        // TODO: Listen for .move and filter by category
        // TODO: Also listen for .update
        if (event.event !== 'documents.publish') {
          return new Response(
            JSON.stringify({
              message: 'Event ignored (not a publish event)',
              event: event.event,
            }),
            {
              headers: { 'Content-Type': 'application/json' },
            },
          );
        }

        const prUrl = await processBlogImport(event, env);

        return new Response(
          JSON.stringify({
            success: true,
            prUrl,
          }),
          {
            headers: { 'Content-Type': 'application/json' },
          },
        );
      } catch (error) {
        console.error('Error processing webhook:', error);
        return new Response(
          JSON.stringify({
            error: error instanceof Error ? error.message : 'Unknown error',
          }),
          {
            status: 500,
            headers: { 'Content-Type': 'application/json' },
          },
        );
      }
    }

    return new Response('Not Found', { status: 404 });
  },
};
