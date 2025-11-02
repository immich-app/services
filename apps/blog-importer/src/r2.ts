export async function clearR2Directory(bucket: R2Bucket, prefix: string): Promise<number> {
  let deletedCount = 0;
  let cursor: string | undefined;

  do {
    const listed = await bucket.list({ prefix, cursor });

    if (listed.objects.length > 0) {
      const keys = listed.objects.map((obj) => obj.key);
      await bucket.delete(keys);
      deletedCount += keys.length;
    }

    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);

  return deletedCount;
}

export async function uploadToR2(
  bucket: R2Bucket,
  key: string,
  data: Uint8Array | ArrayBuffer,
  options?: {
    contentType?: string;
    metadata?: Record<string, string>;
  },
): Promise<void> {
  await bucket.put(key, data, {
    httpMetadata: {
      contentType: options?.contentType || 'application/octet-stream',
    },
    customMetadata: options?.metadata,
  });
}
