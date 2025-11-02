import { formatMarkdown } from './formatter.js';
import { parseFrontmatter, serializeFrontmatter, updateFrontmatter } from './frontmatter.js';
import { GitHubClient } from './github.js';
import { processImage } from './images.js';
import { processMarkdownImages, resolveImageUrl } from './markdown.js';
import { clearR2Directory, uploadToR2 } from './r2.js';
import type { OutlineWebhookEvent } from './types.js';

const BLOG_PREFIX = 'blog';
const OUTPUT_PATH_BASE = 'apps/root.immich.app/src/routes/blog';

/**
 * Verify Outline webhook signature using HMAC.
 */
async function verifyWebhookSignature(
  payload: string,
  signature: string,
  secret: string,
): Promise<boolean> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );

  const signatureBuffer = await crypto.subtle.sign('HMAC', key, encoder.encode(payload));
  const computedSignature = [...new Uint8Array(signatureBuffer)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

  return computedSignature === signature;
}

// CLAUDE: Please remove any redundant comments like this
/**
 * Process a blog post import from Outline.
 */
async function processBlogImport(event: OutlineWebhookEvent, env: Env): Promise<string> {
  const document = event.payload.model;
  console.log(`Processing document: ${document.id} - ${document.title}`);

  // Parse the document text (includes frontmatter)
  // Outline escapes the frontmatter delimiters, so unescape them
  const text = document.text.replaceAll(String.raw`\---`, '---');
  const { data: frontmatterData, content } = parseFrontmatter(text);

  // CLAUDE: What's with all this undefined? What happened to generating the slug from the title as a fallback?
  // Get or generate slug
  const slug = (frontmatterData.slug as string | undefined) || undefined;

  // Clear old images from R2
  const imagePrefix = `${BLOG_PREFIX}/${document.id}/`;
  const deletedCount = await clearR2Directory(env.STATIC_BUCKET, imagePrefix);
  console.log(`Cleared ${deletedCount} old images from R2`);

  // Process markdown images
  const { markdown: processedMarkdown, replacements } = await processMarkdownImages(
    content,
    async (imageUrl) => {
      // Resolve relative URLs
      const absoluteUrl = resolveImageUrl(imageUrl, env.OUTLINE_BASE_URL);

      console.log(`Processing image: ${absoluteUrl}`);

      // Download and convert image
      const { webpData, contentHash } = await processImage(absoluteUrl);

      // Upload to R2
      const r2Key = `${imagePrefix}${contentHash}.webp`;
      await uploadToR2(env.STATIC_BUCKET, r2Key, webpData, {
        contentType: 'image/webp',
      });

      // Return new URL
      const newUrl = `${env.R2_PUBLIC_URL}/${r2Key}`;
      console.log(`Replaced with: ${newUrl}`);

      return newUrl;
    },
  );

  console.log(`Processed ${replacements.length} images`);

  // Update frontmatter
  const updatedFrontmatter = updateFrontmatter(frontmatterData, document, slug);

  // Serialize back to markdown
  const finalMarkdown = serializeFrontmatter(updatedFrontmatter, processedMarkdown);

  // Format with Prettier
  const formattedMarkdown = await formatMarkdown(finalMarkdown);

  // Commit to GitHub and create PR
  const github = new GitHubClient(
    env.GITHUB_APP_ID,
    env.GITHUB_APP_PRIVATE_KEY,
    env.GITHUB_INSTALLATION_ID,
  );

  const branchName = `blog/${document.id}`;
  const filePath = `${OUTPUT_PATH_BASE}/${updatedFrontmatter.slug}/+page.md`;
  const commitMessage = `feat: import ${updatedFrontmatter.slug}`;

  const { prUrl, prNumber } = await github.commitAndCreatePR(
    branchName,
    filePath,
    formattedMarkdown,
    commitMessage, // CLAUDE: No need for the double parameter
    commitMessage,
  );

  console.log(`Created/updated PR #${prNumber}: ${prUrl}`);

  return prUrl;
}

/**
 * Main worker handler.
 */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // CLAUDE: don't do extraneous shit like this
    // Health check endpoint
    if (url.pathname === '/health') {
      return new Response(
        JSON.stringify({
          status: 'healthy',
          timestamp: new Date().toISOString(),
        }),
        {
          headers: {
            'Content-Type': 'application/json',
          },
        },
      );
    }

    // Webhook endpoint
    if (url.pathname === '/webhook' && request.method === 'POST') {
      try {
        // CLAUDE: If we're running in dev (locally), skip signature validation so I can manually post a test request
        // Get webhook signature
        const signature = request.headers.get('Outline-Signature');
        if (!signature) {
          return new Response('Missing webhook signature', { status: 401 });
        }

        // Read payload
        const payload = await request.text();

        // Verify signature
        const isValid = await verifyWebhookSignature(
          payload,
          signature,
          env.OUTLINE_WEBHOOK_SECRET,
        );

        if (!isValid) {
          return new Response('Invalid webhook signature', { status: 401 });
        }

        // Parse webhook event
        const event = JSON.parse(payload) as OutlineWebhookEvent;

        // TODO: Listen for .move and filter by category
        // TODO: Also listen for .update
        // Only process publish events
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

        // Process the blog import
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

    // CLAUDE: Just don't respond or give a 404 or such
    // Default response
    return new Response(
      JSON.stringify({
        message: 'Blog Importer Worker',
        endpoints: {
          '/health': 'Health check',
          '/webhook': 'Outline webhook (POST)',
        },
      }),
      {
        headers: { 'Content-Type': 'application/json' },
      },
    );
  },
};
