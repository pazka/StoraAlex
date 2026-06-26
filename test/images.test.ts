import { describe, it, expect } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import sharp from 'sharp';
import { processAndStore, ImageError } from '../src/server/lib/images.ts';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'storalex-img-'));

describe('image processing (upload pipeline)', () => {
  it('downscales to a 1600px max edge and outputs webp', async () => {
    const buf = await sharp({ create: { width: 2400, height: 1000, channels: 3, background: { r: 10, g: 20, b: 30 } } })
      .jpeg()
      .toBuffer();
    const out = await processAndStore(buf, dir);
    expect(Math.max(out.width, out.height)).toBe(1600);
    const meta = await sharp(path.join(dir, out.path)).metadata();
    expect(meta.format).toBe('webp');
  });

  it('does not enlarge small images', async () => {
    const buf = await sharp({ create: { width: 200, height: 120, channels: 3, background: '#334455' } }).png().toBuffer();
    const out = await processAndStore(buf, dir);
    expect(out.width).toBe(200);
    expect(out.height).toBe(120);
  });

  it('strips EXIF metadata from the stored image', async () => {
    const buf = await sharp({ create: { width: 100, height: 80, channels: 3, background: '#123456' } })
      .withMetadata({ exif: { IFD0: { Copyright: 'secret' } } })
      .jpeg()
      .toBuffer();
    const out = await processAndStore(buf, dir);
    const meta = await sharp(path.join(dir, out.path)).metadata();
    expect(meta.exif).toBeUndefined();
  });

  it('rejects non-image data', async () => {
    await expect(processAndStore(Buffer.from('this is not an image'), dir)).rejects.toBeInstanceOf(ImageError);
  });

  it('stores under a random non-guessable filename', async () => {
    const buf = await sharp({ create: { width: 50, height: 50, channels: 3, background: '#000000' } }).png().toBuffer();
    const out = await processAndStore(buf, dir);
    expect(out.path).toMatch(/^[0-9a-f]{32}\.webp$/);
  });
});
