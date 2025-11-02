# Blog Importer Worker

Cloudflare Worker that automatically imports blog posts from Outline to the Immich static site repository.

## Overview

This worker listens for Outline webhook events (specifically `documents.publish`) and automatically:

1. Receives the published document from Outline
2. Extracts and parses frontmatter and markdown content
3. Downloads all images from the document
4. Converts images to WebP format (quality: 85)
5. Uploads images to R2 storage
6. Updates image URLs in the markdown
7. Formats the content with Prettier
8. Creates a branch in the target GitHub repository
9. Commits the formatted markdown file
10. Creates or updates a pull request

## Architecture

The worker is organized into focused modules:

- **`index.ts`**: Main webhook handler and orchestration
- **`markdown.ts`**: Process markdown AST and replace image URLs
- **`images.ts`**: Download images and convert to WebP
- **`r2.ts`**: R2 bucket operations (upload, clear directory)
- **`github.ts`**: GitHub API client with Octokit
- **`formatter.ts`**: Prettier integration for markdown formatting
- **`types.ts`**: Shared TypeScript interfaces

## Environment Variables

The worker requires the following environment variables:

### R2 Storage

- `STATIC_BUCKET`: R2 bucket binding (configured in wrangler.toml)
- `R2_PUBLIC_URL`: Public URL for R2 bucket (e.g., `https://static.immich.cloud`)

### Outline

- `OUTLINE_WEBHOOK_SECRET`: Secret for verifying webhook signatures
- `OUTLINE_BASE_URL`: Base URL of your Outline instance (e.g., `https://app.getoutline.com`)
- `OUTLINE_API_KEY`: API key for authenticating image downloads

### GitHub App

- `GITHUB_APP_ID`: GitHub App ID
- `GITHUB_APP_PRIVATE_KEY`: GitHub App private key (PEM format)
- `GITHUB_INSTALLATION_ID`: Installation ID for the target organization

## Endpoints

### `GET /`

Returns worker information and available endpoints.

### `GET /health`

Health check endpoint. Returns `200 OK` with current status.

### `POST /webhook`

Outline webhook endpoint. Processes `documents.publish` events.

**Headers:**
- `Outline-Signature`: HMAC-SHA256 signature of the request body

**Body:** Outline webhook event payload

## Development

### Install Dependencies

```bash
pnpm install
```

### Local Development

Create a `.dev.vars` file with required environment variables:

```
OUTLINE_WEBHOOK_SECRET=your-secret
OUTLINE_BASE_URL=https://app.getoutline.com
OUTLINE_API_KEY=your-api-key
R2_PUBLIC_URL=https://static.immich.cloud
GITHUB_APP_ID=123456
GITHUB_APP_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----"
GITHUB_INSTALLATION_ID=123456
SKIP_WEBHOOK_VALIDATION=true
```

**Note**: `SKIP_WEBHOOK_VALIDATION=true` disables webhook signature validation for local testing.

Start the development server:

```bash
pnpm run dev
```

### Testing

Run unit tests:

```bash
pnpm run test
```

The test suite includes comprehensive coverage of:
- ✅ Markdown AST processing and image URL replacement (13 tests)

For manual integration testing:

```bash
# Start development server
pnpm run dev

# Test in another terminal
curl http://localhost:8787/health
curl -X POST http://localhost:8787/webhook -H "Outline-Signature: test" -d '{}'
```

### Type Checking

```bash
pnpm run check
```

### Building

```bash
pnpm run build
```

## Deployment

### Using Wrangler

```bash
wrangler deploy
```

### Using Terraform

See the Terraform module in `deployment/modules/cloudflare/workers/blog-importer/`.

## Webhook Setup

In Outline, configure a webhook:

1. Go to Settings → Webhooks
2. Create a new webhook
3. Set URL to: `https://blog-importer-immich-app.workers.dev/webhook`
4. Set secret to match `OUTLINE_WEBHOOK_SECRET`
5. Enable `documents.publish` event

## How It Works

### Webhook Processing Flow

1. **Verification**: HMAC signature is verified using `OUTLINE_WEBHOOK_SECRET`
2. **Event Filtering**: Only `documents.publish` events are processed
3. **Frontmatter Parsing**: Document text is parsed to extract YAML frontmatter
4. **Image Processing**:
   - Markdown AST is traversed to find all images
   - Each image is downloaded and decoded
   - Images are converted to WebP format
   - WebP images are uploaded to R2 at `blog/{document-id}/{md5-hash}.webp`
   - Image URLs in markdown are replaced with R2 URLs
5. **Frontmatter Update**: Metadata is updated with document ID, title, publish date, etc.
6. **Formatting**: Final markdown is formatted with Prettier
7. **Git Operations**:
   - Branch `blog/{document-id}` is created/force-updated
   - File is committed to `apps/root.immich.app/src/routes/blog/{slug}/+page.md`
   - PR is created or updated with title `blog: import {slug}`

### Image Format Support

The worker supports the following input formats:
- JPEG (.jpg, .jpeg)
- PNG (.png)
- WebP (.webp)

All images are converted to WebP format with quality 85.

### GitHub Authentication

The worker uses GitHub App authentication:
1. Generates a JWT using the App private key
2. Exchanges JWT for an installation access token
3. Uses the token for all GitHub API requests

This is more secure than personal access tokens and provides better audit trails.

## Hardcoded Values

The following values are currently hardcoded (can be made configurable later):

- **Target Repository**: `immich/static-pages`
- **Base Branch**: `main`
- **Output Path**: `apps/root.immich.app/src/routes/blog`
- **R2 Prefix**: `blog`
- **WebP Quality**: 85
- **Authors**: `['Immich Team']`

## Differences from Python Version

This worker replaces the Python script (`import-post.py`) with the following improvements:

1. **Webhook-Driven**: No manual workflow dispatch needed
2. **Native R2 Bindings**: Uses Cloudflare R2 bindings instead of S3 SDK
3. **Integrated Prettier**: Formats markdown directly in the worker (enabled in dev/prod, disabled in tests)
4. **GitHub App Auth**: More secure than workflow tokens
5. **Comprehensive Tests**: Unit tests for core functionality
6. **TypeScript**: Type-safe implementation with better IDE support

## Future Enhancements

Potential improvements:

- Make target repository configurable via environment variables
- Support additional image formats (GIF, SVG, etc.)
- Add image optimization options (quality, max dimensions)
- Implement retry logic for failed image downloads
- Add metrics and monitoring
- Support draft posts (not just published)
