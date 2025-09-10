# GitHub Approval Check App

A GitHub App implemented as a Cloudflare Worker that enforces pull request approval requirements from authorized team members.

## Overview

This worker creates a GitHub Check that validates whether a pull request has been approved by an authorized team member (admin or team role). It solves the problem of GitHub's native approval workflows creating separate check marks for different event triggers.

## Features

- ✅ Creates a single, consistent check run for PR approval status
- ✅ Validates approvals against a configurable list of authorized users
- ✅ Updates check status in real-time when reviews are submitted
- ✅ Provides detailed feedback about approval requirements
- ✅ Secure webhook signature verification
- ✅ JWT-based GitHub App authentication

## Setup

### 1. Create a GitHub App

1. Go to your GitHub organization settings → Developer settings → GitHub Apps
2. Click "New GitHub App"
3. Configure the app:
   - **Name**: `Immich Approval Check` (or your preferred name)
   - **Homepage URL**: Your organization URL
   - **Webhook URL**: `https://your-worker-domain.workers.dev/webhook`
   - **Webhook secret**: Generate a secure random string
   - **Permissions**:
     - **Checks**: Read & Write
     - **Pull requests**: Read
     - **Contents**: Read (for accessing repository)
   - **Subscribe to events**:
     - Check run
     - Check suite
     - Pull request
     - Pull request review
4. After creation, note down:
   - App ID
   - Generate and download a private key

### 2. Configure the Worker

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

### 3. Deploy the Worker

```bash
# Development
pnpm run dev

# Production
wrangler deploy
```

### 4. Install the GitHub App

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

1. **PR Opened/Updated**: Creates a check run and validates current approvals
2. **Review Submitted**: Updates the check based on the new review
3. **Check Suite Requested**: Runs the approval check for the PR
4. **Check Re-requested**: Re-validates the current approval status

The check will show:
- ✅ **Success**: When approved by an authorized team member
- ❌ **Failure**: When approval is still required
- 📝 **Detailed feedback**: Shows who has reviewed and who can approve

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