export async function verifyWebhookSignature(body: string, signature: string, secret: string): Promise<boolean> {
  if (!signature.startsWith('sha256=')) {
    return false;
  }

  const providedSignature = signature.slice(7);

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );

  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  const computedSignature = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('');

  return timingSafeEqual(computedSignature, providedSignature);
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }

  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.codePointAt(i)! ^ b.codePointAt(i)!;
  }

  return result === 0;
}
