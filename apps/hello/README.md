# hello.immich.app

A simple Cloudflare Worker API example for the Immich project.

## Endpoints

- `GET /` - Returns a hello message
- `GET /health` - Health check endpoint
- `GET /api/greet?name=<name>` - Personalized greeting

## Development

```bash
# Install dependencies
pnpm install

# Run locally
pnpm run dev
```

## Testing

```bash
pnpm test
```
