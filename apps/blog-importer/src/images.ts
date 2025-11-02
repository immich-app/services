import { decode as decodeJpeg } from '@jsquash/jpeg';
import { decode as decodePng } from '@jsquash/png';
import { decode as decodeWebp, encode as encodeWebp } from '@jsquash/webp';
import type { ImageProcessingResult } from './types.js';

const WEBP_QUALITY = 85;

/**
 * Download an image from a URL.
 */
export async function downloadImage(url: string): Promise<ArrayBuffer> {
  // CLAUDE: We need an outline API key for this request
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download image from ${url}: ${response.status} ${response.statusText}`);
  }
  return response.arrayBuffer();
}

// CLAUDE: Do we really need this shit? In python, pillow was able to figure it out itself just fine
/**
 * Determine image type from file extension or content.
 */
function getImageType(url: string, data: ArrayBuffer): 'jpeg' | 'png' | 'webp' | 'unknown' {
  // Check URL extension first
  const urlLower = url.toLowerCase();
  if (urlLower.endsWith('.jpg') || urlLower.endsWith('.jpeg')) {
    return 'jpeg';
  }
  if (urlLower.endsWith('.png')) {
    return 'png';
  }
  if (urlLower.endsWith('.webp')) {
    return 'webp';
  }

  // Check magic bytes
  const bytes = new Uint8Array(data);
  if (bytes.length < 4) {
    return 'unknown';
  }

  // JPEG: FF D8 FF
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'jpeg';
  }

  // PNG: 89 50 4E 47
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return 'png';
  }

  // WebP: RIFF....WEBP
  if (
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes.length >= 12 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return 'webp';
  }

  return 'unknown';
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
  url: string,
  quality: number = WEBP_QUALITY,
): Promise<ArrayBuffer> {
  const imageType = getImageType(url, imageData);

  if (imageType === 'unknown') {
    throw new Error(`Unsupported image format for ${url}`);
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
 */
export async function processImage(url: string): Promise<ImageProcessingResult> {
  const imageData = await downloadImage(url);
  const webpData = await convertToWebp(imageData, url);
  const contentHash = await hashContent(webpData); // CLAUDE: this is wrong, hash the original data not the converted webp

  return {
    webpData,
    contentHash,
  };
}
