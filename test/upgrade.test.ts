// Upgrade safety net: characterization tests that pin behaviour most likely to
// break on a Node major bump or a native-dependency bump (node:sqlite, argon2,
// sharp, pdf-lib, fastify cookie/ajv). They describe what the app does TODAY.
// See TESTING.md.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import sharp from 'sharp';
import { PDFDocument } from 'pdf-lib';
import type { FastifyInstance } from 'fastify';
import { makeApp, loginCookie } from './helpers.ts';
import { loadConfig } from '../src/server/config.ts';
import { openDb, tx } from '../src/server/db/index.ts';
import { buildApp } from '../src/server/app.ts';
import { createRepos } from '../src/server/db/repos.ts';
import { hashPassword, verifyPassword } from '../src/server/auth/password.ts';

// Every route the app registers today. A new route must be added here, which
// forces a decision about whether it is behind the auth gate.
const PROTECTED_ROUTES: [string, string][] = [
  ['GET', '/api/me'],
  ['GET', '/api/users'],
  ['POST', '/api/users'],
  ['DELETE', '/api/users/1'],
  ['POST', '/api/users/1/password'],
  ['GET', '/api/items'],
  ['POST', '/api/items'],
  ['GET', '/api/items/1'],
  ['PATCH', '/api/items/1'],
  ['DELETE', '/api/items/1'],
  ['POST', '/api/items/1/archive'],
  ['POST', '/api/items/1/unarchive'],
  ['GET', '/api/items/1/codes'],
  ['POST', '/api/items/1/move'],
  ['POST', '/api/items/1/tags'],
  ['DELETE', '/api/items/1/tags/1'],
  ['POST', '/api/items/bulk-move'],
  ['GET', '/api/places'],
  ['POST', '/api/places'],
  ['GET', '/api/places/1'],
  ['PATCH', '/api/places/1'],
  ['DELETE', '/api/places/1'],
  ['POST', '/api/places/1/archive'],
  ['POST', '/api/places/1/unarchive'],
  ['GET', '/api/places/1/codes'],
  ['POST', '/api/places/1/move'],
  ['POST', '/api/places/1/tags'],
  ['DELETE', '/api/places/1/tags/1'],
  ['GET', '/api/resolve/OBJ-000001'],
  ['POST', '/api/codes/print'],
  ['POST', '/api/codes/assign'],
  ['GET', '/api/tags'],
  ['POST', '/api/tags'],
  ['GET', '/api/movements'],
  ['POST', '/api/media'],
  ['GET', '/media/1'],
  ['GET', '/api/sheet/status'],
  ['POST', '/api/sheet/export'],
  ['GET', '/api/export.xlsx'],
  ['POST', '/api/import.xlsx'],
  // Unknown paths under the gated prefixes are gated too.
  ['GET', '/api/does-not-exist'],
  ['GET', '/media/..%2F..%2Fetc%2Fpasswd'],
];

describe('auth gate covers every /api and /media route', () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    ({ app } = await makeApp());
  });
  afterAll(async () => {
    await app.close();
  });

  it.each(PROTECTED_ROUTES)('%s %s -> 401 without a session', async (method, url) => {
    const res = await app.inject({ method: method as 'GET', url });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'unauthorized' });
  });

  it('a forged (unsigned) session cookie is rejected', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie: 'storalex_sid=forged' } });
    expect(res.statusCode).toBe(401);
  });

  it('public routes stay public', async () => {
    expect((await app.inject({ method: 'GET', url: '/healthz' })).json()).toEqual({ status: 'ok' });
    expect((await app.inject({ method: 'GET', url: '/api/setup-needed' })).json()).toEqual({ needed: false });
    expect((await app.inject({ method: 'POST', url: '/api/auth/logout' })).json()).toEqual({ ok: true });
    const bad = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'nobody', password: 'x' },
    });
    expect(bad.statusCode).toBe(401);
    expect(bad.json()).toEqual({ error: 'invalid credentials' });
  });
});

describe('node:sqlite: migrations, schema, transactions', () => {
  function schema(db: ReturnType<typeof openDb>) {
    const objects = db
      .prepare("SELECT type, name, tbl_name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name")
      .all() as { type: string; name: string; tbl_name: string }[];
    const columns: Record<string, string[]> = {};
    for (const o of objects.filter((x) => x.type === 'table')) {
      const cols = db.prepare(`PRAGMA table_info("${o.name}")`).all() as {
        name: string;
        type: string;
        notnull: number;
        pk: number;
      }[];
      columns[o.name] = cols.map((c) => `${c.name} ${c.type}${c.notnull ? ' NOT NULL' : ''}${c.pk ? ' PK' : ''}`);
    }
    return { objects: objects.map((o) => `${o.type} ${o.name} on ${o.tbl_name}`), columns };
  }

  it('runs all migrations on a fresh database and pins the resulting schema', () => {
    const db = openDb(':memory:');
    const applied = (db.prepare('SELECT name FROM schema_migrations ORDER BY name').all() as { name: string }[]).map(
      (r) => r.name,
    );
    expect(applied).toEqual([
      '001_init.sql',
      '002_movement_immutable.sql',
      '003_place_tags.sql',
      '004_drop_place_type_add_price.sql',
      '005_archive.sql',
    ]);
    expect(schema(db)).toMatchSnapshot();
    db.close();
  });

  it('re-opening an existing file database is idempotent (no migration re-run)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'storalex-db-'));
    const file = path.join(dir, 'x.db');
    openDb(file).close();
    const db = openDb(file);
    const n = db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get() as { n: number };
    expect(n.n).toBe(5);
    expect((db.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode).toBe('wal');
    expect((db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number }).foreign_keys).toBe(1);
    db.close();
  });

  it('tx() is re-entrant: an inner throw rolls back the whole outer transaction', () => {
    const db = openDb(':memory:');
    db.exec('CREATE TABLE t (v INTEGER)');
    expect(() =>
      tx(db, () => {
        db.prepare('INSERT INTO t VALUES (1)').run();
        tx(db, () => {
          db.prepare('INSERT INTO t VALUES (2)').run();
          throw new Error('boom');
        });
      }),
    ).toThrow('boom');
    expect((db.prepare('SELECT COUNT(*) AS n FROM t').get() as { n: number }).n).toBe(0);
    // A nested success commits together with the outer one.
    tx(db, () => {
      db.prepare('INSERT INTO t VALUES (1)').run();
      tx(db, () => db.prepare('INSERT INTO t VALUES (2)').run());
    });
    expect((db.prepare('SELECT COUNT(*) AS n FROM t').get() as { n: number }).n).toBe(2);
    db.close();
  });

  it('tx() refuses an async callback', () => {
    const db = openDb(':memory:');
    expect(() => tx(db, (async () => 1) as unknown as () => number)).toThrow(/synchronous/);
    db.close();
  });

  it('the movement audit log is append-only (triggers survive the upgrade)', () => {
    const db = openDb(':memory:');
    const objects = schema(db).objects;
    expect(objects).toContain('trigger movement_no_update on movement');
    expect(objects).toContain('trigger movement_no_delete on movement');
    db.close();
  });
});

describe('argon2id + pepper (@node-rs/argon2)', () => {
  const PEPPER = 'known-pepper-for-upgrade-tests';
  // Produced by the app's hashPassword() on @node-rs/argon2 2.0.2 / Node 24.
  // Must keep verifying after any upgrade, or every existing user is locked out.
  const KNOWN_HASH =
    '$argon2id$v=19$m=19456,t=2,p=1$ycmhg0thW0cfj58azBClbQ$VhKgfDIXNH2AaKd4PIdN1dqIOCZntm29H0iwTpocJAA';

  it('a hash stored before the upgrade still verifies', async () => {
    expect(await verifyPassword(KNOWN_HASH, 'known-password-v1', PEPPER)).toBe(true);
    expect(await verifyPassword(KNOWN_HASH, 'wrong', PEPPER)).toBe(false);
    expect(await verifyPassword(KNOWN_HASH, 'known-password-v1', 'other-pepper-value')).toBe(false);
  });

  it('hash + verify round-trip uses argon2id with the pinned cost parameters', async () => {
    const h = await hashPassword('round-trip-pw', PEPPER);
    expect(h).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    expect(await verifyPassword(h, 'round-trip-pw', PEPPER)).toBe(true);
  });

  it('a malformed stored hash yields false, never throws', async () => {
    expect(await verifyPassword('not-a-hash', 'x', PEPPER)).toBe(false);
  });
});

describe('uploads through the HTTP route (sharp)', () => {
  let app: FastifyInstance;
  let cookie: string;
  let mediaDir: string;
  beforeAll(async () => {
    ({ app, mediaDir } = await makeApp());
    cookie = await loginCookie(app);
  });
  afterAll(async () => {
    await app.close();
  });

  function multipart(filename: string, contentType: string, body: Buffer) {
    const boundary = '----storalexTestBoundary';
    const payload = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
          `Content-Type: ${contentType}\r\n\r\n`,
      ),
      body,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    return { payload, headers: { cookie, 'content-type': `multipart/form-data; boundary=${boundary}` } };
  }

  it('accepts a JPEG with EXIF, stores an EXIF-free webp under a random name, serves it', async () => {
    const jpg = await sharp({ create: { width: 64, height: 48, channels: 3, background: '#808080' } })
      .withMetadata({ exif: { IFD0: { Artist: 'should-be-stripped' } } })
      .jpeg()
      .toBuffer();
    expect((await sharp(jpg).metadata()).exif).toBeDefined();

    const res = await app.inject({ method: 'POST', url: '/api/media', ...multipart('photo.jpg', 'image/jpeg', jpg) });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { photo_id: number; width: number; height: number };
    expect(body).toMatchObject({ width: 64, height: 48 });

    const files = fs.readdirSync(mediaDir).filter((f) => f.endsWith('.webp'));
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) expect(f).toMatch(/^[0-9a-f]{32}\.webp$/);

    const served = await app.inject({ method: 'GET', url: `/media/${body.photo_id}`, headers: { cookie } });
    expect(served.statusCode).toBe(200);
    expect(served.headers['content-type']).toBe('image/webp');
    const meta = await sharp(served.rawPayload).metadata();
    expect(meta.format).toBe('webp');
    expect(meta.exif).toBeUndefined();
  });

  it('rejects a non-image disguised with an image extension and MIME type', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/media',
      ...multipart('evil.png', 'image/png', Buffer.from('<?php echo 1; ?>')),
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('PDF label sheet (pdf-lib + qrcode)', () => {
  let app: FastifyInstance;
  let cookie: string;
  beforeAll(async () => {
    ({ app } = await makeApp());
    cookie = await loginCookie(app);
  });
  afterAll(async () => {
    await app.close();
  });

  it('returns a valid PDF with 24 labels per A4 page', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/codes/print',
      headers: { cookie },
      payload: { type: 'item', count: 25 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.headers['content-disposition']).toBe('attachment; filename="storalex-labels-item-25.pdf"');
    expect(res.rawPayload.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    const doc = await PDFDocument.load(res.rawPayload);
    expect(doc.getPageCount()).toBe(2);
    const [w, h] = [doc.getPage(0).getWidth(), doc.getPage(0).getHeight()];
    expect([Math.round(w), Math.round(h)]).toEqual([595, 842]);
  });

  it('rejects counts outside 1..200 and unknown fields', async () => {
    const big = await app.inject({
      method: 'POST',
      url: '/api/codes/print',
      headers: { cookie },
      payload: { type: 'item', count: 201 },
    });
    expect(big.statusCode).toBe(400);
    const extra = await app.inject({
      method: 'POST',
      url: '/api/codes/print',
      headers: { cookie },
      payload: { type: 'item', count: 1, color: 'red' },
    });
    expect(extra.statusCode).toBe(400);
  });
});

describe('production mode', () => {
  const prodEnv = {
    NODE_ENV: 'production',
    APP_PEPPER: 'p'.repeat(32),
    SESSION_KEY: 's'.repeat(32),
    DB_PATH: ':memory:',
  };

  it('refuses to boot without APP_PEPPER / SESSION_KEY', () => {
    expect(() => loadConfig({ NODE_ENV: 'production' })).toThrow(/APP_PEPPER, SESSION_KEY/);
    expect(() => loadConfig({ NODE_ENV: 'production', APP_PEPPER: 'short', SESSION_KEY: 's'.repeat(32) })).toThrow(
      /APP_PEPPER/,
    );
  });

  it('defaults trustProxy to one hop in production', () => {
    expect(loadConfig(prodEnv).trustProxy).toBe(1);
  });

  it('a numeric TRUST_PROXY trusts exactly that many hops for req.ip / req.protocol', async () => {
    // Per-IP rate limiting keys on req.ip: behind the single reverse proxy it must
    // be the real client (right-most X-Forwarded-For), not the proxy and not the
    // client-controlled left-most value.
    for (const [hops, xff, expected] of [
      ['1', '198.51.100.9, 203.0.113.7', '203.0.113.7'],
      ['2', '198.51.100.9, 203.0.113.7', '198.51.100.9'],
    ] as const) {
      const config = loadConfig({ ...prodEnv, TRUST_PROXY: hops });
      const db = openDb(config.dbPath);
      const app = await buildApp(config, db);
      app.log.level = 'silent';
      app.get('/__whoami', async (req) => ({ ip: req.ip, ips: req.ips, protocol: req.protocol }));
      await app.ready();
      try {
        const res = await app.inject({
          method: 'GET',
          url: '/__whoami',
          remoteAddress: '10.0.0.2',
          headers: { 'x-forwarded-for': xff, 'x-forwarded-proto': 'https' },
        });
        expect(res.json()).toMatchObject({ ip: expected, protocol: 'https' });
        expect(res.json().ips[0]).toBe('10.0.0.2');
      } finally {
        await app.close();
        db.close();
      }
    }
  });

  it('sets a __Host- session cookie: httpOnly, Secure, SameSite=Strict, signed; CSP on', async () => {
    const mediaDir = fs.mkdtempSync(path.join(os.tmpdir(), 'storalex-prod-'));
    const config = loadConfig({ ...prodEnv, DATA_DIR: mediaDir, MEDIA_DIR: mediaDir });
    const db = openDb(config.dbPath);
    createRepos(db).users.create('prod', await hashPassword('prod-password-1', config.appPepper));
    const app = await buildApp(config, db);
    app.log.level = 'silent';
    await app.ready();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { username: 'prod', password: 'prod-password-1' },
      });
      expect(res.statusCode).toBe(200);
      const c = res.cookies.find((x) => x.name === '__Host-storalex_sid');
      expect(c).toBeDefined();
      expect(c).toMatchObject({ httpOnly: true, secure: true, sameSite: 'Strict', path: '/' });
      expect(c!.domain).toBeUndefined();
      // Signed by @fastify/cookie: "<token>.<signature>"
      expect(c!.value).toMatch(/^[A-Za-z0-9_-]{43}\..+$/);

      const h = await app.inject({ method: 'GET', url: '/healthz' });
      expect(h.headers['content-security-policy']).toContain("default-src 'self'");
      expect(h.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    } finally {
      await app.close();
      db.close();
    }
  });
});

describe('Google Sheet mirror unconfigured', () => {
  it('boots without SHEET_ID: status 200, export 501, app stays healthy', async () => {
    const { app } = await makeApp();
    const cookie = await loginCookie(app);
    try {
      expect(app.sheetMirror.configured).toBe(false);
      const status = await app.inject({ method: 'GET', url: '/api/sheet/status', headers: { cookie } });
      expect(status.statusCode).toBe(200);
      const exp = await app.inject({ method: 'POST', url: '/api/sheet/export', headers: { cookie } });
      expect(exp.statusCode).toBe(501);
      expect((await app.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });
});
