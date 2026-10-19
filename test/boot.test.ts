// Boot test: the COMPILED app (npm run build -> dist/) started as a real
// process with NODE_ENV=production, exercised over raw HTTP. Catches what the
// in-process tests can't: tsc output / NodeNext ESM resolution, migrations
// copied into dist, the SPA static serving, real socket path handling, process
// startup/shutdown and log output — i.e. Node major bumps and build-tool bumps.
//
// Skipped when dist/ is missing (plain `npm test` before a build) unless
// REQUIRE_BUILD=1, which CI sets so a missing build fails instead of skipping.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { randomBytes } from 'node:crypto';
import sharp from 'sharp';
import { PROTECTED_ROUTES, concreteUrl } from './routes.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
const ENTRY = path.join(ROOT, 'dist/server/index.js');
const built = fs.existsSync(ENTRY) && fs.existsSync(path.join(ROOT, 'dist/client/index.html'));
if (!built && process.env.REQUIRE_BUILD === '1') {
  throw new Error('REQUIRE_BUILD=1 but dist/ is missing — run `npm run build` first');
}

// Fake secrets for the test process only.
const FAKE = { APP_PEPPER: 'boot-test-pepper-'.padEnd(40, 'x'), SESSION_KEY: 'boot-test-session-key-'.padEnd(40, 'y') };

interface Res {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

function request(port: number, method: string, rawPath: string, opts: { headers?: http.OutgoingHttpHeaders; body?: Buffer | string } = {}): Promise<Res> {
  return new Promise((resolve, reject) => {
    // http.request sends `path` verbatim (no dot-segment / slash normalisation).
    // agent:false = one connection per request: the server may close a socket
    // after an early 401, and a pooled keep-alive socket would then hang up.
    const headers = { ...opts.headers, ...(opts.body !== undefined ? { 'content-length': Buffer.byteLength(opts.body) } : {}) };
    const req = http.request({ host: '127.0.0.1', port, method, path: rawPath, headers, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}
const json = (r: Res) => JSON.parse(r.body.toString('utf8'));

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as net.AddressInfo;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

interface Proc {
  child: ChildProcess;
  port: number;
  out: () => string;
  err: () => string;
  exited: Promise<number | null>;
}

/**
 * Start dist/server/index.js from a scratch cwd (so no developer .env is ever
 * loaded) that links to the real dist/ (so the SPA is served as in the image).
 * The environment is built from scratch: nothing is inherited but PATH.
 */
function start(env: Record<string, string>, port: number, cwd: string): Proc {
  const child = spawn(process.execPath, [ENTRY], {
    cwd,
    env: { PATH: process.env.PATH ?? '', HOST: '127.0.0.1', PORT: String(port), ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  let err = '';
  child.stdout!.on('data', (c) => (out += c));
  child.stderr!.on('data', (c) => (err += c));
  const exited = new Promise<number | null>((r) => child.on('exit', (code) => r(code)));
  return { child, port, out: () => out, err: () => err, exited };
}

async function waitHealthy(p: Proc, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (p.child.exitCode !== null) throw new Error(`server exited early (${p.child.exitCode}):\n${p.err()}\n${p.out()}`);
    try {
      const r = await request(p.port, 'GET', '/healthz');
      if (r.status === 200) return;
    } catch {
      /* not listening yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`server not healthy after ${timeoutMs}ms:\n${p.err()}\n${p.out()}`);
}

function scratchCwd(): string {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'storalex-boot-cwd-'));
  // 'junction' needs no admin rights on Windows; the type is ignored elsewhere.
  fs.symlinkSync(path.join(ROOT, 'dist'), path.join(cwd, 'dist'), 'junction');
  return cwd;
}

/** Lines on stderr that are expected noise (Node's experimental-feature notice for node:sqlite). */
const benignStderr = (line: string) => !line.trim() || /ExperimentalWarning: SQLite|--trace-warnings/.test(line);

describe.skipIf(!built)('compiled app (dist/) in production mode', () => {
  let proc: Proc;
  let dataDir: string;
  let cwd: string;
  let cookie = '';

  beforeAll(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'storalex-boot-data-'));
    cwd = scratchCwd();
    proc = start({ NODE_ENV: 'production', DATA_DIR: dataDir, ...FAKE }, await freePort(), cwd);
    await waitHealthy(proc);
  }, 30000);

  afterAll(async () => {
    if (proc?.child.exitCode === null) {
      proc.child.kill('SIGKILL');
      await proc.exited;
    }
  });

  it('answers /healthz', async () => {
    const r = await request(proc.port, 'GET', '/healthz');
    expect(r.status).toBe(200);
    expect(json(r)).toEqual({ status: 'ok' });
  });

  it('created the SQLite DB under DATA_DIR (migrations shipped in dist/)', () => {
    expect(fs.existsSync(path.join(dataDir, 'storalex.db'))).toBe(true);
    expect(fs.existsSync(path.join(ROOT, 'dist/server/db/migrations/001_init.sql'))).toBe(true);
  });

  it('every protected route answers 401 without a session', async () => {
    const failures: string[] = [];
    for (const { method, url } of PROTECTED_ROUTES) {
      const r = await request(proc.port, method, concreteUrl(url), { headers: { 'content-type': 'application/json' }, body: method === 'GET' ? undefined : '{}' });
      if (r.status !== 401 || json(r).error !== 'unauthorized') failures.push(`${method} ${url} -> ${r.status}`);
    }
    expect(failures).toEqual([]);
  });

  it('unknown /api/* and /media/* paths are gated too', async () => {
    for (const p of ['/api/nope', '/media/nope', '/api/items/../users', '/media/../api/users']) {
      expect((await request(proc.port, 'GET', p)).status, p).toBe(401);
    }
  });

  it('raw path variants that dodge the prefix check never return API data', async () => {
    for (const p of ['//api/items', '/API/items', '/healthz/../api/items', '/./api/items', '/%2e/api/items', '/api%2fitems', '/media%2f1']) {
      const r = await request(proc.port, 'GET', p);
      const isJsonData = r.status === 200 && String(r.headers['content-type']).includes('application/json');
      expect(isJsonData, `${p} -> ${r.status} ${r.headers['content-type']}`).toBe(false);
    }
  });

  it('serves the PWA shell with the production CSP and SPA fallback', async () => {
    const root = await request(proc.port, 'GET', '/');
    expect(root.status).toBe(200);
    expect(root.headers['content-type']).toMatch(/^text\/html/);
    expect(root.body.toString()).toContain('<div id="root">');
    expect(root.headers['content-security-policy']).toContain("script-src 'self'");
    const deep = await request(proc.port, 'GET', '/items/42');
    expect(deep.status).toBe(200);
    expect(deep.body.toString()).toContain('<div id="root">');
    const sw = await request(proc.port, 'GET', '/sw.js');
    expect(sw.status).toBe(200);
    expect(sw.headers['content-type']).toMatch(/javascript/);
  });

  it('first-run setup issues a production session cookie (__Host-, HttpOnly, Secure, SameSite=Strict, signed)', async () => {
    expect(json(await request(proc.port, 'GET', '/api/setup-needed'))).toEqual({ needed: true });
    const r = await request(proc.port, 'POST', '/api/auth/setup', {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'owner', password: 'boot-test-password' }),
    });
    expect(r.status).toBe(201);
    const sc = [r.headers['set-cookie']].flat()[0]!;
    // <base64url token>.<base64 HMAC, URI-encoded by the cookie serializer>
    expect(sc).toMatch(/^__Host-storalex_sid=[A-Za-z0-9_-]{43}\.(?:[A-Za-z0-9]|%2B|%2F){43};/);
    for (const a of ['HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/']) expect(sc).toContain(a);
    expect(sc).not.toMatch(/Domain=/i);
    cookie = sc.split(';')[0]!;

    const me = await request(proc.port, 'GET', '/api/me', { headers: { cookie } });
    expect(me.status).toBe(200);
    expect(json(me).user.username).toBe('owner');
  });

  it('authenticated: unknown /api path is a JSON 404, sheet mirror reports not configured', async () => {
    const nf = await request(proc.port, 'GET', '/api/nope', { headers: { cookie } });
    expect(nf.status).toBe(404);
    expect(json(nf)).toEqual({ error: 'not found' });
    const st = await request(proc.port, 'GET', '/api/sheet/status', { headers: { cookie } });
    expect(json(st)).toMatchObject({ configured: false, lastError: null });
  });

  it('native deps work in the compiled app: sharp upload and PDF labels', async () => {
    const png = await sharp({ create: { width: 30, height: 10, channels: 3, background: '#abcdef' } }).png().toBuffer();
    const b = `----storalex${randomBytes(6).toString('hex')}`;
    const body = Buffer.concat([
      Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="file"; filename="x.png"\r\nContent-Type: image/png\r\n\r\n`),
      png,
      Buffer.from(`\r\n--${b}--\r\n`),
    ]);
    const up = await request(proc.port, 'POST', '/api/media', { headers: { cookie, 'content-type': `multipart/form-data; boundary=${b}` }, body });
    expect(up.status).toBe(201);
    const { photo_id } = json(up);
    const media = await request(proc.port, 'GET', `/media/${photo_id}`, { headers: { cookie } });
    expect(media.status).toBe(200);
    expect(media.body.subarray(8, 12).toString()).toBe('WEBP');
    const files = fs.readdirSync(path.join(dataDir, 'media'));
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^[0-9a-f]{32}\.webp$/);

    const pdf = await request(proc.port, 'POST', '/api/codes/print', {
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'item', count: 2 }),
    });
    expect(pdf.status).toBe(200);
    expect(pdf.body.subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('logs JSON lines at info level with no errors, and nothing unexpected on stderr', () => {
    const lines = proc
      .out()
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { level: number; msg: string });
    expect(lines.some((l) => /StorAlex listening on http:\/\/127\.0\.0\.1:\d+ \(env=production\)/.test(l.msg))).toBe(true);
    expect(lines.filter((l) => l.level >= 50)).toEqual([]);
    expect(lines.some((l) => l.level < 30)).toBe(false); // no debug in production
    expect(proc.err().split('\n').filter((l) => !benignStderr(l))).toEqual([]);
  });

  // Windows has no SIGTERM delivery (kill() terminates), so the exit code is only
  // meaningful on POSIX — which is what CI and the Docker image run.
  it.skipIf(process.platform === 'win32')('shuts down cleanly on SIGTERM, then a restart on the same DATA_DIR keeps users and sessions', async () => {
    proc.child.kill('SIGTERM');
    expect(await proc.exited).toBe(0);

    const again = start({ NODE_ENV: 'production', DATA_DIR: dataDir, ...FAKE }, await freePort(), cwd);
    try {
      await waitHealthy(again);
      expect(json(await request(again.port, 'GET', '/api/setup-needed'))).toEqual({ needed: false });
      const me = await request(again.port, 'GET', '/api/me', { headers: { cookie } });
      expect(me.status).toBe(200); // same SESSION_KEY + persisted session row
      const login = await request(again.port, 'POST', '/api/auth/login', {
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: 'owner', password: 'boot-test-password' }),
      });
      expect(login.status).toBe(200); // same APP_PEPPER + persisted argon2id hash
    } finally {
      again.child.kill('SIGTERM');
      expect(await again.exited).toBe(0);
    }
  }, 30000);
});

describe.skipIf(!built)('compiled app refuses an insecure production start', () => {
  it('exits non-zero without APP_PEPPER / SESSION_KEY', async () => {
    const p = start({ NODE_ENV: 'production', DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'storalex-boot-data-')) }, await freePort(), scratchCwd());
    expect(await p.exited).not.toBe(0);
    expect(p.err()).toContain('Missing required secrets in production: APP_PEPPER, SESSION_KEY');
  });
});
