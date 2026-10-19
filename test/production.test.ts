// Production-mode behaviour that only shows when NODE_ENV=production: the
// session cookie (name, flags, signature format), helmet headers, and the
// refusal to boot without secrets. Guards @fastify/cookie, @fastify/helmet and
// fastify upgrades. boot.test.ts re-checks the cookie flags on the compiled app.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHash, createHmac } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import type { FastifyInstance } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import { loadConfig } from '../src/server/config.ts';
import { openDb } from '../src/server/db/index.ts';
import { buildApp } from '../src/server/app.ts';
import { makeApp, TEST_SESSION_KEY } from './helpers.ts';

const FAKE_ENV = { APP_PEPPER: 'c'.repeat(32), SESSION_KEY: TEST_SESSION_KEY };

/** A real production config. Only `env` is reset so Fastify's logger stays quiet. */
async function makeProdApp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'storalex-prod-'));
  const config = loadConfig({ NODE_ENV: 'production', DB_PATH: ':memory:', DATA_DIR: dir, ...FAKE_ENV });
  expect(config.isProd).toBe(true);
  const db = openDb(config.dbPath);
  const app = await buildApp({ ...config, env: 'test' }, db);
  await app.ready();
  return { app, db };
}

/** cookie-signature's format: "<value>.<base64(HMAC-SHA256(value))>" without padding. */
const sign = (value: string, secret: string) =>
  `${value}.${createHmac('sha256', secret).update(value).digest('base64').replace(/=+$/, '')}`;

describe('production session cookie', () => {
  let app: FastifyInstance;
  let db: DatabaseSync;
  let setCookie: string;
  let value: string;

  beforeAll(async () => {
    ({ app, db } = await makeProdApp());
    const res = await app.inject({ method: 'POST', url: '/api/auth/setup', payload: { username: 'owner', password: 'longenough1' } });
    expect(res.statusCode).toBe(201);
    setCookie = [res.headers['set-cookie']].flat().join('\n');
    value = res.cookies.find((c) => c.name === '__Host-storalex_sid')!.value;
  });
  afterAll(async () => {
    await app.close();
  });

  it('uses the __Host- prefixed name with HttpOnly, Secure, SameSite=Strict, Path=/ and no Domain', () => {
    expect(setCookie).toMatch(/^__Host-storalex_sid=[^;]+;/);
    const attrs = setCookie.split(';').slice(1).map((a) => a.trim());
    expect(attrs).toEqual(expect.arrayContaining(['HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/', 'Max-Age=2592000']));
    expect(setCookie).not.toMatch(/Domain=/i);
  });

  it('is signed with SESSION_KEY in the cookie-signature format (existing sessions survive upgrades)', () => {
    const token = value.slice(0, value.lastIndexOf('.'));
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/); // 32 random bytes, base64url
    expect(value).toBe(sign(token, TEST_SESSION_KEY));
    expect(app.unsignCookie(value)).toEqual({ valid: true, renew: false, value: token });
  });

  it('stores only sha256(token) server-side', () => {
    const token = value.slice(0, value.lastIndexOf('.'));
    const ids = (db.prepare('SELECT id FROM session').all() as { id: string }[]).map((r) => r.id);
    expect(ids).toEqual([createHash('sha256').update(token).digest('hex')]);
  });

  it('authenticates with the cookie, and ignores the un-prefixed dev cookie name', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/me', headers: { cookie: `__Host-storalex_sid=${value}` } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/me', headers: { cookie: `storalex_sid=${value}` } })).statusCode).toBe(401);
  });

  it('accepts a cookie signed externally with the same key (format compatibility)', async () => {
    const token = value.slice(0, value.lastIndexOf('.'));
    const res = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie: `__Host-storalex_sid=${sign(token, TEST_SESSION_KEY)}` } });
    expect(res.statusCode).toBe(200);
    const wrongKey = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie: `__Host-storalex_sid=${sign(token, 'z'.repeat(32))}` } });
    expect(wrongKey.statusCode).toBe(401);
  });

  it('logout revokes the session server-side and clears the cookie with matching attributes', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie: `__Host-storalex_sid=${value}` } });
    expect(res.statusCode).toBe(200);
    const cleared = [res.headers['set-cookie']].flat().join('\n');
    expect(cleared).toMatch(/^__Host-storalex_sid=;/);
    expect(cleared).toMatch(/Expires=Thu, 01 Jan 1970 00:00:00 GMT/);
    for (const a of ['HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/']) expect(cleared).toContain(a);
    expect(db.prepare('SELECT COUNT(*) AS n FROM session').get()).toEqual({ n: 0 });
    expect((await app.inject({ method: 'GET', url: '/api/me', headers: { cookie: `__Host-storalex_sid=${value}` } })).statusCode).toBe(401);
  });
});

describe('production security headers (helmet)', () => {
  it('sends the pinned CSP and hardening headers', async () => {
    const { app } = await makeProdApp();
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.headers['content-security-policy']).toBe(
      "default-src 'self';script-src 'self';style-src 'self' 'unsafe-inline';img-src 'self' data: blob:;" +
        "connect-src 'self';worker-src 'self';manifest-src 'self';object-src 'none';frame-ancestors 'none';" +
        "base-uri 'self';form-action 'self';" +
        // helmet merges its own defaults for directives the app does not set:
        "font-src 'self' https: data:;script-src-attr 'none';upgrade-insecure-requests",
    );
    expect(res.headers['strict-transport-security']).toBe('max-age=31536000; includeSubDomains');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('SAMEORIGIN');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['cross-origin-opener-policy']).toBe('same-origin');
    expect(res.headers['x-powered-by']).toBeUndefined();
    await app.close();
  });
});

describe('development / test mode differences', () => {
  it('uses the bare cookie name without Secure, and sends no CSP', async () => {
    const { app } = await makeApp({ seed: false });
    const res = await app.inject({ method: 'POST', url: '/api/auth/setup', payload: { username: 'dev', password: 'longenough1' } });
    const sc = [res.headers['set-cookie']].flat().join('\n');
    expect(sc).toMatch(/^storalex_sid=/);
    expect(sc).toContain('HttpOnly');
    expect(sc).toContain('SameSite=Strict');
    expect(sc).not.toContain('Secure');
    expect(res.headers['content-security-policy']).toBeUndefined();
    await app.close();
  });
});

describe('production config', () => {
  it('refuses to start without APP_PEPPER / SESSION_KEY (or with short ones)', () => {
    expect(() => loadConfig({ NODE_ENV: 'production' })).toThrow(/Missing required secrets in production: APP_PEPPER, SESSION_KEY/);
    expect(() => loadConfig({ NODE_ENV: 'production', APP_PEPPER: 'short', SESSION_KEY: 'x'.repeat(16) })).toThrow(/APP_PEPPER/);
  });

  it('defaults: trustProxy=1 hop, port 8080, DB and media under DATA_DIR, 30-day sessions, no sheet', () => {
    const c = loadConfig({ NODE_ENV: 'production', DATA_DIR: '/data', ...FAKE_ENV });
    expect(c).toMatchObject({
      trustProxy: 1,
      port: 8080,
      host: '0.0.0.0',
      dbPath: path.join('/data', 'storalex.db'),
      mediaDir: path.join('/data', 'media'),
      sessionTtlDays: 30,
      maxUploadBytes: 15 * 1024 * 1024,
      sheetId: null,
      googleServiceAccountJson: null,
    });
  });

  it('parses TRUST_PROXY hop counts, booleans and addresses', () => {
    const tp = (v: string) => loadConfig({ NODE_ENV: 'production', TRUST_PROXY: v, ...FAKE_ENV }).trustProxy;
    expect(tp('2')).toBe(2);
    expect(tp('true')).toBe(true);
    expect(tp('false')).toBe(false);
    expect(tp('10.0.0.0/8')).toBe('10.0.0.0/8');
  });
});
