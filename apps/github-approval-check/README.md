# GitHub Approval Check

A Cloudflare Worker that creates GitHub check runs to enforce approval requirements on pull requests using organization-level webhooks.

## Overview

This worker listens for GitHub organization webhook events and creates/updates check runs based on pull request approval status. It ensures that only authorized team members can approve PRs for merging.

## Features

- ✅ Creates a single, consistent check run for PR approval status
- ✅ Validates approvals against a configurable list of authorized users
- ✅ Updates check status in real-time when reviews are submitted
- ✅ Provides detailed feedback about approval requirements
- ✅ Secure webhook signature verification
- ✅ JWT-based GitHub App authentication
- ✅ Dev mode for PR-specific deployments

## Setup

### 1. Create a GitHub App

1. Go to your GitHub organization settings → Developer settings → GitHub Apps
2. Click "New GitHub App"
3. Configure the app:
   - **Name**: `Immich Approval Check` (or your preferred name)
   - **Homepage URL**: Your organization URL
   - **Permissions**:
     - **Checks**: Read & Write
     - **Pull requests**: Read
     - **Contents**: Read (for accessing repository)
   - **Events**: Leave all unchecked (using org webhooks instead)
4. After creation, note down:
   - App ID
   - Generate and download a private key

### 2. Configure Organization Webhook

1. Go to Organization Settings → Webhooks
2. Add webhook with:
   - **Payload URL**: `https://your-worker-domain.workers.dev/webhook`
   - **Content type**: `application/json`
   - **Secret**: Generate a secure random string
   - **Events to trigger**:
     - Check runs
     - Check suites
     - Pull requests
     - Pull request reviews

### 3. Configure the Worker

#### Local Development

Create `.dev.vars` file:

```bash
GITHUB_APP_ID=your_app_id
GITHUB_APP_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----
your_private_key_content_here
-----END RSA PRIVATE KEY-----"
GITHUB_WEBHOOK_SECRET=your_webhook_secret
```

#### Production Deployment

Set secrets using Wrangler:

```bash
wrangler secret put GITHUB_APP_PRIVATE_KEY
# Paste your private key when prompted

wrangler secret put GITHUB_WEBHOOK_SECRET
# Enter your webhook secret when prompted
```

Update `wrangler.toml` with your App ID:

```toml
[vars]
GITHUB_APP_ID = "your_app_id"
```

### 4. Deploy the Worker

```bash
# Development
pnpm run dev

# Production
wrangler deploy
```

### 5. Install the GitHub App

1. Go to your GitHub App settings
2. Click "Install App"
3. Choose the organization/repositories where you want to install it
4. The app will automatically start validating pull requests

## Configuration

### Allowed Users List

The worker fetches the list of authorized approvers from a configurable URL. By default, it uses:
`https://raw.githubusercontent.com/immich-app/devtools/main/tf/deployment/data/users.json`

The JSON structure should be:

```json
[
  {
    "github": {
      "username": "user1",
      "id": 12345
    },
    "role": "admin"
  },
  {
    "github": {
      "username": "user2",
      "id": 67890
    },
    "role": "team"
  }
]
```

Users with `role` of "admin" or "team" are authorized to approve pull requests.

## How It Works

1. **Organization webhook received**: GitHub sends webhook for PR events across all repos
2. **Validation**: Worker validates webhook signature using org secret
3. **Check approval**: Fetches allowed users and PR reviews
4. **Update check**:
   - ✅ **Approved**: Creates/updates check with success status
   - ⚠️ **Not approved + previously approved**: Updates to action_required
   - **Not approved + never approved**: No check created (keeps PR clean)

The check behavior:

- **Clean PR view**: No check appears until someone approves
- **Blocks merge**: Missing required check prevents merging
- **Clear feedback**: Shows approval status without exposing approver list

## Dev Mode

When deployed as part of a pull request (with `TF_VAR_stage` containing `-pr-XXX`), the worker automatically enters dev mode:

- **Limited scope**: Only processes webhooks for the `services` repository (hardcoded)
- **PR-specific**: Only responds to events for the PR that created the deployment
- **Automatic detection**: Extracts PR number from the stage variable

### Environment Variables in Dev Mode

```env
ENVIRONMENT=dev              # Or automatically detected from stage
STAGE=-pr-123               # Set by Terraform from TF_VAR_stage
```

The worker automatically:

- Detects dev mode from the `-pr-` prefix in the stage
- Extracts the PR number (e.g., 123 from `-pr-123`)
- Limits processing to only the `services` repository
- Ignores webhooks from other repositories or PRs

This ensures PR deployments don't interfere with production checks and only test against their own changes.

## Development

### Running Tests

```bash
pnpm run test
```

### Type Checking

```bash
pnpm run check
```

## Troubleshooting

### Check Not Appearing

- Ensure the GitHub App is installed on the repository
- Verify webhook URL is correct in GitHub App settings
- Check worker logs: `pnpm run tail`

### Authentication Errors

- Verify App ID is correct
- Ensure private key is properly formatted (including headers)
- Check that the private key matches the GitHub App

### Webhook Signature Failures

- Ensure webhook secret matches between GitHub and worker config
- Verify the secret doesn't contain any extra whitespace

## Security Considerations

- Private keys and webhook secrets are stored as encrypted secrets
- All webhooks are verified using HMAC-SHA256 signatures
- Installation tokens are cached with appropriate TTLs
- Authorized users list is cached to reduce external API calls
