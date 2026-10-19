// Characterization: the full route table and the URL-prefix auth gate (app.ts
// needsAuth()). Guards fastify / find-my-way / @fastify/cookie upgrades: a
// router change that normalises paths differently, or a hook-order change,
// would silently open routes.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { makeApp, loginCookie } from './helpers.ts';
import { PUBLIC_ROUTES, PROTECTED_ROUTES, concreteUrl } from './routes.ts';

// Record every route the real buildApp() registers, by wrapping the Fastify
// factory (test-only; no production seam needed).
const registered = vi.hoisted(() => [] as { method: string; url: string }[]);
vi.mock('fastify', async (importOriginal) => {
  const mod = await importOriginal<typeof import('fastify')>();
  const wrapped = (opts: Parameters<typeof mod.default>[0]) => {
    const app = mod.default(opts);
    app.addHook('onRoute', (r) => {
      for (const m of [r.method].flat()) registered.push({ method: m, url: r.url });
    });
    return app;
  };
  return { ...mod, default: wrapped };
});

let app: FastifyInstance;
let db: import('node:sqlite').DatabaseSync;
beforeAll(async () => {
  const m = await makeApp();
  app = m.app;
  db = m.db;
});
afterAll(async () => {
  await app.close();
});

const key = (r: { method: string; url: string }) => `${r.method} ${r.url}`;

describe('route inventory', () => {
  it('registers exactly the pinned API/media routes', () => {
    // Static-file routes from @fastify/static (only present after a build) and
    // auto HEAD routes are excluded; everything else must be pinned.
    const actual = registered
      .filter((r) => r.method !== 'HEAD')
      .filter((r) => r.url.startsWith('/api') || r.url.startsWith('/media') || r.url === '/healthz')
      .map(key)
      .sort();
    const expected = [...PUBLIC_ROUTES, ...PROTECTED_ROUTES].map(key).sort();
    expect(actual).toEqual(expected);
  });

  it('auto-registers HEAD for GET routes (exposeHeadRoutes default)', () => {
    expect(registered.map(key)).toContain('HEAD /api/items');
  });
});

describe('auth gate (no session)', () => {
  it.each(PROTECTED_ROUTES.map((r) => [r.method, r.url] as const))('%s %s -> 401', async (method, url) => {
    const res = await app.inject({ method, url: concreteUrl(url) });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'unauthorized' });
  });

  it('gates unknown /api/* and /media/* paths too (prefix match, before routing)', async () => {
    for (const url of ['/api/does-not-exist', '/api/', '/media/', '/api/items?x=1', '/api/%69tems']) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(401);
    }
  });

  it('does not route path variants that dodge the prefix check (no 2xx without a session)', async () => {
    // These URLs do not start with "/api/" so the gate lets them through; they
    // must therefore never reach a real handler. Pins find-my-way defaults
    // (caseSensitive, no duplicate-slash normalisation). inject() resolves dot
    // segments itself; boot.test.ts replays these over a raw HTTP socket.
    for (const url of ['//api/items', '/API/items', '/healthz/../api/items', '/./api/items']) {
      const res = await app.inject({ method: 'GET', url });
      const leaked = res.statusCode === 200 && String(res.headers['content-type']).includes('application/json');
      expect(leaked, `${url} -> ${res.statusCode}`).toBe(false);
    }
  });

  it('rejects an unsigned, tampered or unknown session cookie', async () => {
    const good = await loginCookie(app); // storalex_sid=<token>.<sig>
    const value = good.split('=')[1]!;
    const [token] = value.split('.');
    const variants = [
      `storalex_sid=${token}`, // unsigned
      `storalex_sid=${value.slice(0, -2)}xx`, // bad signature
      `storalex_sid=${app.signCookie('not-a-real-session')}`, // validly signed, no such session
    ];
    for (const cookie of variants) {
      const res = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie } });
      expect(res.statusCode, cookie).toBe(401);
    }
    expect((await app.inject({ method: 'GET', url: '/api/me', headers: { cookie: good } })).statusCode).toBe(200);
  });

  it('rejects an expired session and a logged-out session', async () => {
    const cookie = await loginCookie(app);
    db.exec(`UPDATE session SET expires_at = datetime('now', '-1 minute')`);
    expect((await app.inject({ method: 'GET', url: '/api/me', headers: { cookie } })).statusCode).toBe(401);

    const fresh = await loginCookie(app);
    expect((await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie: fresh } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/me', headers: { cookie: fresh } })).statusCode).toBe(401);
  });
});

describe('public routes answer without a session', () => {
  it('GET /healthz', async () => {
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
  });
  it('GET /api/setup-needed', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/setup-needed' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ needed: false });
  });
  it('POST /api/auth/login validates instead of 401-gating', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: {} });
    expect(res.statusCode).toBe(400);
  });
  it('POST /api/auth/logout without a cookie', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/auth/logout' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });
  it('POST /api/auth/setup is refused (403) once a user exists', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/auth/setup', payload: { username: 'x', password: 'longenough1' } });
    expect(res.statusCode).toBe(403);
  });
});
