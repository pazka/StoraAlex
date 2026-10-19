// Upload pipeline end to end through POST /api/media and GET /media/:id
// (SPEC §7.7). Guards sharp/libvips, @fastify/multipart and Node bumps:
// magic-byte validation, re-encode to WebP, EXIF strip, random filenames,
// size cap and path-traversal-guarded serving.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { makeApp, loginCookie } from './helpers.ts';

const EXIF_MARKER = 'storalex-exif-marker';

function multipart(filename: string, contentType: string, data: Buffer) {
  const boundary = `----storalex${randomBytes(8).toString('hex')}`;
  const head = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`;
  return {
    payload: Buffer.concat([Buffer.from(head), data, Buffer.from(`\r\n--${boundary}--\r\n`)]),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}

/** 40x20 red JPEG, EXIF orientation 6 (rotate 90° CW) + a copyright marker. */
const exifJpeg = () =>
  sharp({ create: { width: 40, height: 20, channels: 3, background: '#ff0000' } })
    .withMetadata({ orientation: 6, exif: { IFD0: { Copyright: EXIF_MARKER } } })
    .jpeg()
    .toBuffer();

let app: FastifyInstance;
let db: DatabaseSync;
let mediaDir: string;
let cookie: string;

beforeAll(async () => {
  const m = await makeApp();
  ({ app, db, mediaDir } = m);
  cookie = await loginCookie(app);
});
afterAll(async () => {
  await app.close();
});

const files = () => fs.readdirSync(mediaDir).sort();
const upload = (filename: string, type: string, data: Buffer) => {
  const mp = multipart(filename, type, data);
  return app.inject({ method: 'POST', url: '/api/media', payload: mp.payload, headers: { ...mp.headers, cookie } });
};

describe('POST /api/media', () => {
  it('re-encodes a JPEG with EXIF to an EXIF-free WebP, applying orientation', async () => {
    const input = await exifJpeg();
    expect(input.includes(Buffer.from(EXIF_MARKER))).toBe(true); // fixture sanity
    const before = files();

    const res = await upload('photo.jpg', 'image/jpeg', input);
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body).toEqual({ photo_id: expect.any(Number), width: 20, height: 40 }); // rotated
    expect(Object.keys(body).sort()).toEqual(['height', 'photo_id', 'width']);

    const added = files().filter((f) => !before.includes(f));
    expect(added).toHaveLength(1);
    expect(added[0]).toMatch(/^[0-9a-f]{32}\.webp$/);

    const stored = fs.readFileSync(path.join(mediaDir, added[0]!));
    expect(stored.subarray(0, 4).toString()).toBe('RIFF');
    expect(stored.subarray(8, 12).toString()).toBe('WEBP');
    expect(stored.includes(Buffer.from(EXIF_MARKER))).toBe(false);
    const meta = await sharp(stored).metadata();
    expect(meta).toMatchObject({ format: 'webp', width: 20, height: 40 });
    expect(meta.exif).toBeUndefined();
    expect(meta.xmp).toBeUndefined();
    expect(meta.icc).toBeUndefined();
    expect(meta.orientation).toBeUndefined();

    const row = db.prepare('SELECT path, width, height, bytes FROM photo WHERE id = ?').get(body.photo_id);
    expect(row).toEqual({ path: added[0], width: 20, height: 40, bytes: stored.length });
  });

  it('accepts a PNG regardless of the declared filename/mimetype', async () => {
    const png = await sharp({ create: { width: 8, height: 8, channels: 4, background: '#00ff0080' } }).png().toBuffer();
    const res = await upload('weird.bin', 'application/octet-stream', png);
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ width: 8, height: 8 });
  });

  it('gives identical uploads different random filenames', async () => {
    const input = await exifJpeg();
    const before = files();
    expect((await upload('a.jpg', 'image/jpeg', input)).statusCode).toBe(201);
    expect((await upload('a.jpg', 'image/jpeg', input)).statusCode).toBe(201);
    const added = files().filter((f) => !before.includes(f));
    expect(added).toHaveLength(2);
    expect(added[0]).not.toBe(added[1]);
    for (const f of added) expect(f).not.toContain('a.jpg');
  });

  it('rejects a non-image with an image extension and mimetype (magic bytes win), writing nothing', async () => {
    const before = files();
    const res = await upload('evil.jpg', 'image/jpeg', Buffer.from('<?php echo "hi"; ?> definitely not a jpeg'));
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'not a readable image' });
    expect(files()).toEqual(before);
  });

  it('rejects SVG (sharp can decode it, but it is not an allowed input format)', async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script>alert(1)</script></svg>');
    const res = await upload('x.png', 'image/png', svg);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'unsupported image format: svg' });
  });

  it('KNOWN BUG (TESTING.md): a truncated JPEG yields 500 with the libvips message, not 400', async () => {
    // metadata() accepts the header, then the failOn:'error' re-encode throws a
    // plain Error (not ImageError) which the route rethrows. Pinned as-is so an
    // upgrade that changes it is noticed; update this test when it is fixed.
    const full = await sharp({ create: { width: 400, height: 300, channels: 3, background: '#123456' } }).jpeg().toBuffer();
    const before = files();
    const res = await upload('cut.jpg', 'image/jpeg', full.subarray(0, Math.floor(full.length / 2)));
    expect(res.statusCode).toBe(500);
    expect(res.json()).toMatchObject({ statusCode: 500, error: 'Internal Server Error', message: expect.stringMatching(/JPEG/i) });
    expect(files().filter((f) => !before.includes(f))).toHaveLength(0);
  });

  it('answers a non-multipart body with 400 "invalid multipart upload"', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/media', payload: { a: 1 }, headers: { cookie } });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'invalid multipart upload' });
  });

  it('answers a multipart body with no file part with 400 "no file provided"', async () => {
    const boundary = '----storalexnofile';
    const res = await app.inject({
      method: 'POST',
      url: '/api/media',
      payload: `--${boundary}\r\nContent-Disposition: form-data; name="note"\r\n\r\nhello\r\n--${boundary}--\r\n`,
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, cookie },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'no file provided' });
  });
});

describe('upload size cap', () => {
  it('rejects a file over MAX_UPLOAD_BYTES with 413', async () => {
    const small = await makeApp({ env: { MAX_UPLOAD_BYTES: '2048' } });
    const c = await loginCookie(small.app);
    const big = await sharp({ create: { width: 300, height: 300, channels: 3, background: '#808080' } })
      .png({ compressionLevel: 0 })
      .toBuffer();
    expect(big.length).toBeGreaterThan(2048);
    const mp = multipart('big.png', 'image/png', big);
    const res = await small.app.inject({ method: 'POST', url: '/api/media', payload: mp.payload, headers: { ...mp.headers, cookie: c } });
    expect(res.statusCode).toBe(413);
    expect(res.json()).toEqual({ error: 'file too large' });
    expect(fs.readdirSync(small.mediaDir)).toEqual([]);
    await small.app.close();
  });
});

describe('GET /media/:id', () => {
  it('serves the stored WebP privately and immutably cached', async () => {
    const up = await upload('p.jpg', 'image/jpeg', await exifJpeg());
    const id = up.json().photo_id;
    const res = await app.inject({ method: 'GET', url: `/media/${id}`, headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/webp');
    expect(res.headers['cache-control']).toBe('private, max-age=31536000, immutable');
    const meta = await sharp(res.rawPayload).metadata();
    expect(meta).toMatchObject({ format: 'webp', width: 20, height: 40 });
  });

  it('404s an unknown photo id and 400s a non-numeric id', async () => {
    expect((await app.inject({ method: 'GET', url: '/media/999999', headers: { cookie } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/media/abc', headers: { cookie } })).statusCode).toBe(400);
  });

  it('refuses to serve a stored path that escapes the media dir', async () => {
    const r = db.prepare("INSERT INTO photo (path, width, height, bytes) VALUES ('../../../etc/passwd', 1, 1, 1)").run();
    const res = await app.inject({ method: 'GET', url: `/media/${r.lastInsertRowid}`, headers: { cookie } });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'bad path' });
  });

  it('404s when the row exists but the file is gone', async () => {
    const r = db.prepare("INSERT INTO photo (path, width, height, bytes) VALUES ('0123456789abcdef0123456789abcdef.webp', 1, 1, 1)").run();
    const res = await app.inject({ method: 'GET', url: `/media/${r.lastInsertRowid}`, headers: { cookie } });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'file missing' });
  });
});
