import { decode as decodeJpeg } from '@jsquash/jpeg';
import { decode as decodePng } from '@jsquash/png';
import { decode as decodeWebp, encode as encodeWebp } from '@jsquash/webp';
import imageType from 'image-type';
import type { ImageProcessingResult } from './types.js';

const WEBP_QUALITY = 85;

/**
 * Download an image from a URL with Outline API authentication.
 */
export async function downloadImage(url: string, apiKey: string): Promise<ArrayBuffer> {
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
  });
  if (!response.ok) {
    throw new Error(`Failed to download image from ${url}: ${response.status} ${response.statusText}`);
  }
  return response.arrayBuffer();
}

/**
 * Determine image type from buffer using image-type library.
 */
async function getImageType(data: ArrayBuffer): Promise<'jpeg' | 'png' | 'webp' | 'unknown'> {
  const result = await imageType(new Uint8Array(data));

  if (!result) {
    return 'unknown';
  }

  // Map mime types to our supported formats
  switch (result.mime) {
    case 'image/jpeg': {
      return 'jpeg';
    }
    case 'image/png': {
      return 'png';
    }
    case 'image/webp': {
      return 'webp';
    }
    default: {
      return 'unknown';
    }
  }
}

/**
 * Decode an image to raw ImageData.
 */
async function decodeImage(
  data: ArrayBuffer,
  type: 'jpeg' | 'png' | 'webp',
): Promise<{
  data: Uint8ClampedArray;
  width: number;
  height: number;
  colorSpace?: string;
}> {
  switch (type) {
    case 'jpeg': {
      return decodeJpeg(data);
    }
    case 'png': {
      return decodePng(data);
    }
    case 'webp': {
      return decodeWebp(data);
    }
  }
}

/**
 * Convert image data to WebP format.
 */
export async function convertToWebp(
  imageData: ArrayBuffer,
  quality: number = WEBP_QUALITY,
): Promise<ArrayBuffer> {
  const imageType = await getImageType(imageData);

  if (imageType === 'unknown') {
    throw new Error('Unsupported image format');
  }

  // Decode the image to ImageData
  const decoded = await decodeImage(imageData, imageType);

  // Encode to WebP
  const webpData = await encodeWebp(decoded, { quality });

  return webpData;
}

/**
 * Calculate MD5 hash of data.
 * Note: MD5 is used for content addressing, not security.
 */
export async function hashContent(data: Uint8Array | ArrayBuffer): Promise<string> {
  const hashBuffer = await crypto.subtle.digest('MD5', data);
  const hashArray = [...new Uint8Array(hashBuffer)];
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Download an image, convert to WebP, and calculate hash.
 * The hash is calculated from the original image data for content addressing.
 */
export async function processImage(url: string, apiKey: string): Promise<ImageProcessingResult> {
  const imageData = await downloadImage(url, apiKey);
  const contentHash = await hashContent(imageData);
  const webpData = await convertToWebp(imageData);

  return {
    webpData,
    contentHash,
  };
}
