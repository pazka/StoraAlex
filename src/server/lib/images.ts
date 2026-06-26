import sharp, { type Metadata } from 'sharp';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs/promises';

const MAX_EDGE = 1600;
// Decode ceiling (~50 MP) — guards against decompression-bomb OOM: a tiny but
// highly-compressible file could otherwise decode to a ~1 GB bitmap. Covers
// even high-resolution phone cameras; the output is downscaled anyway.
const MAX_PIXELS = 50 * 1024 * 1024;
// Formats we accept on upload. sharp reading the buffer is the authoritative
// magic-byte check; the declared mimetype is not trusted.
const ALLOWED_INPUT = new Set(['jpeg', 'png', 'webp', 'avif', 'gif', 'tiff', 'heif', 'jpg']);

export class ImageError extends Error {}

export interface StoredImage {
  path: string; // relative to mediaDir
  width: number;
  height: number;
  bytes: number;
}

/**
 * Validate, downscale, re-encode (defangs malicious payloads), strip EXIF, and
 * store an uploaded image under a random filename. See SPEC §7.7.
 */
export async function processAndStore(buf: Buffer, mediaDir: string): Promise<StoredImage> {
  let meta: Metadata;
  try {
    meta = await sharp(buf, { limitInputPixels: MAX_PIXELS }).metadata();
  } catch {
    throw new ImageError('not a readable image');
  }
  if (!meta.format || !ALLOWED_INPUT.has(meta.format)) {
    throw new ImageError(`unsupported image format: ${meta.format ?? 'unknown'}`);
  }
  // Reject oversized images up front (clean 400) before allocating the bitmap.
  if (meta.width && meta.height && meta.width * meta.height > MAX_PIXELS) {
    throw new ImageError('image dimensions too large');
  }

  await fs.mkdir(mediaDir, { recursive: true });
  const name = `${randomBytes(16).toString('hex')}.webp`;
  const full = path.join(mediaDir, name);

  // .rotate() with no args bakes in EXIF orientation; the re-encode then drops
  // all metadata (sharp does not copy EXIF unless withMetadata() is called).
  const out = await sharp(buf, { failOn: 'error', limitInputPixels: MAX_PIXELS })
    .rotate()
    .resize({ width: MAX_EDGE, height: MAX_EDGE, fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 80 })
    .toFile(full);

  return { path: name, width: out.width, height: out.height, bytes: out.size };
}
