import { decode as decodeJpeg } from '@jsquash/jpeg';
import { decode as decodePng } from '@jsquash/png';
import { decode as decodeWebp, encode as encodeWebp } from '@jsquash/webp';
import imageType from 'image-type';
import type { ImageProcessingResult } from './types.js';

const WEBP_QUALITY = 85;

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

async function getImageType(data: ArrayBuffer): Promise<'jpeg' | 'png' | 'webp' | 'unknown'> {
  const result = await imageType(new Uint8Array(data));

  if (!result) {
    return 'unknown';
  }

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

export async function convertToWebp(
  imageData: ArrayBuffer,
  quality: number = WEBP_QUALITY,
): Promise<ArrayBuffer> {
  const imageType = await getImageType(imageData);

  if (imageType === 'unknown') {
    throw new Error('Unsupported image format');
  }

  const decoded = await decodeImage(imageData, imageType);

  return await encodeWebp(decoded, { quality });
}

export async function hashContent(data: Uint8Array | ArrayBuffer): Promise<string> {
  const hashBuffer = await crypto.subtle.digest('MD5', data);
  const hashArray = [...new Uint8Array(hashBuffer)];
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function processImage(url: string, apiKey: string): Promise<ImageProcessingResult> {
  const imageData = await downloadImage(url, apiKey);
  const contentHash = await hashContent(imageData);
  const webpData = await convertToWebp(imageData);

  return {
    webpData,
    contentHash,
  };
}
