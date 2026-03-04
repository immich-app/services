import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { App } from 'octokit';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/webhook/outline' && request.method === 'POST') {
      try {
        const payload = await request.text();

        if (env.SKIP_WEBHOOK_VALIDATION !== 'true') {
          const messageSignature = request.headers.get('Outline-Signature');
          if (!messageSignature) {
            return new Response('invalid signature', { status: 401 });
          }
          const computedSignature = bytesToHex(
            hmac(sha256, utf8ToBytes(env.OUTLINE_WEBHOOK_SECRET), utf8ToBytes(payload)),
          );

          if (computedSignature !== messageSignature) {
            return new Response('invalid signature', { status: 401 });
          }
        }

        const githubClient = await new App({
          appId: env.GITHUB_APP_ID,
          privateKey: env.GITHUB_APP_PRIVATE_KEY,
        }).getInstallationOctokit(Number.parseInt(env.GITHUB_INSTALLATION_ID));

        await githubClient.rest.repos.createDispatchEvent({
          owner: 'immich-app',
          repo: 'static-pages',
          event_type: 'outline-webhook',
          client_payload: { payload },
        });

        return new Response(
          JSON.stringify({
            success: true,
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
