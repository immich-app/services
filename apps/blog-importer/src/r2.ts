/**
 * Clear all objects in an R2 bucket with a given prefix.
 * Useful for cleaning up old images before uploading new ones.
 */
export async function clearR2Directory(bucket: R2Bucket, prefix: string): Promise<number> {
  let deletedCount = 0;
  let cursor: string | undefined;

  do {
    const listed = await bucket.list({ prefix, cursor });

    if (listed.objects.length > 0) {
      // R2 bucket.delete() accepts an array of keys
      const keys = listed.objects.map((obj) => obj.key);
      await Promise.all(keys.map((key) => bucket.delete(key)));
      deletedCount += keys.length;
    }

    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);

  return deletedCount;
}

/**
 * Upload data to R2 bucket.
 */
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
