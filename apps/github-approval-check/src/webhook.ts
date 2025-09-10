/**
 * Webhook signature verification
 * Ensures that webhooks are coming from GitHub
 */

/**
 * Verify the webhook signature using HMAC-SHA256
 */
export async function verifyWebhookSignature(
  body: string,
  signature: string,
  secret: string
): Promise<boolean> {
  // The signature format is "sha256=<hex digest>"
  if (!signature.startsWith('sha256=')) {
    return false;
  }

  const providedSignature = signature.slice(7); // Remove "sha256=" prefix

  // Import the secret as a key
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );

  // Generate the HMAC
  const mac = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(body)
  );

  // Convert to hex string
  const computedSignature = [...new Uint8Array(mac)]
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');

  // Constant-time comparison to prevent timing attacks
  return safeCompare(computedSignature, providedSignature);
}

/**
 * Constant-time string comparison to prevent timing attacks
 */
function safeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }

  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.codePointAt(i)! ^ b.codePointAt(i)!;
  }

  return result === 0;
}
