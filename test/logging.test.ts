// Logging standard (pazka/hosh-management AGENTS.md section 11): one JSON object per line on stdout,
// the startup / shutdown lines, one error line, which requests are logged, and what never is.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadConfig } from '../src/server/config.ts';
import { openDb } from '../src/server/db/index.ts';
import { buildApp } from '../src/server/app.ts';
import { createRepos } from '../src/server/db/repos.ts';
import { hashPassword } from '../src/server/auth/password.ts';
import { createSheetMirror, type SheetClientFactory } from '../src/server/lib/sheet.ts';
import { pruneSessions } from '../src/server/lib/jobs.ts';
import {
  configNamesSet,
  createLogger,
  errField,
  levelFromEnv,
  log,
  reconfigureLog,
  requestId,
  SLOW_MS,
} from '../src/server/lib/log.ts';
import { TEST_PW, TEST_USER } from './helpers.ts';

const BASE_FIELDS = ['ts', 'level', 'service', 'version', 'event', 'msg'];
type Line = Record<string, any>;

function capture(level = 'debug') {
  const lines: Line[] = [];
  const raw: string[] = [];
  const logger = createLogger(level, { write: (s: string) => (raw.push(s), lines.push(JSON.parse(s)), true) }, 'v9.9.9');
  return { logger, lines, raw };
}

async function appWith(level = 'debug') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'storalex-log-'));
  const config = loadConfig({
    NODE_ENV: 'test',
    APP_PEPPER: 'a'.repeat(32),
    SESSION_KEY: 'b'.repeat(32),
    DB_PATH: ':memory:',
    DATA_DIR: dir,
    MEDIA_DIR: dir,
  });
  const db = openDb(config.dbPath);
  createRepos(db).users.create(TEST_USER, await hashPassword(TEST_PW, config.appPepper));
  const cap = capture(level);
  const app = await buildApp(config, db, { logger: cap.logger });
  // test-only routes, outside the auth gate (not under /api or /media)
  app.get('/boom/:id', async () => {
    throw new Error('kaput');
  });
  app.get('/upstream/:id', async (_req, reply) => reply.code(502).send({ error: 'upstream refused' }));
  app.get('/slow/:id', async () => {
    await new Promise((r) => setTimeout(r, SLOW_MS + 100));
    return { ok: true };
  });
  await app.ready();
  return { app, ...cap };
}

describe('logger', () => {
  it('writes one JSON object per line with the standard fields', () => {
    const { logger, raw, lines } = capture('info');
    logger.info('thing_done', 'thing done', { count: 3 });
    expect(raw).toHaveLength(1);
    expect(raw[0]!.endsWith('\n')).toBe(true);
    expect(raw[0]!.trimEnd()).not.toContain('\n');
    const l = lines[0]!;
    expect(Object.keys(l).slice(0, 6)).toEqual(BASE_FIELDS);
    expect(l).toMatchObject({ level: 'info', service: 'storalex', version: 'v9.9.9', event: 'thing_done', count: 3 });
    expect(new Date(l.ts).toISOString()).toBe(l.ts); // UTC ISO 8601 with ms
  });

  it('drops lines below the level; an unknown level means info', () => {
    const { logger, lines } = capture('warn');
    logger.debug('a', 'a');
    logger.info('b', 'b');
    logger.warn('c', 'c');
    logger.error('d', 'd');
    expect(lines.map((l) => l.event)).toEqual(['c', 'd']);
    expect(capture('loud').logger.level).toBe('info');
  });

  it('LOG_LEVEL, else APP_LOG_LEVEL, else info', () => {
    expect(levelFromEnv({})).toBe('info');
    expect(levelFromEnv({ APP_LOG_LEVEL: 'debug' })).toBe('debug');
    expect(levelFromEnv({ LOG_LEVEL: 'warn', APP_LOG_LEVEL: 'debug' })).toBe('warn');
  });

  it('config: names that are set, never their values', () => {
    const names = configNamesSet({ PORT: '8080', APP_PEPPER: 'pepper-secret', SHEET_ID: '', UNRELATED: 'x' });
    expect(names).toEqual(['PORT', 'APP_PEPPER']);
    expect(JSON.stringify(names)).not.toContain('pepper-secret');
  });

  it('err: type, message, stack frames; hidden strings and e-mail addresses removed', () => {
    const e = new TypeError('cannot read /items/42?token=abc for sa-bot@proj.iam.gserviceaccount.com');
    const { err } = errField(e, ['/items/42?token=abc']);
    expect(err.type).toBe('TypeError');
    expect(err.message).toBe('cannot read <hidden> for <email>');
    expect(String(err.stack)).toMatch(/^TypeError: cannot read <hidden> for <email>\n\s+at /);
    expect(JSON.stringify(err)).not.toContain('token=abc');
    expect(JSON.stringify(err)).not.toContain('gserviceaccount');
    expect(errField('plain')).toEqual({ err: { type: 'string', message: 'plain' } });
  });

  it('X-Request-Id: a plain token of at most 64 chars is kept, anything else is replaced', () => {
    expect(requestId('abc-123')).toBe('abc-123');
    expect(requestId('a'.repeat(64))).toBe('a'.repeat(64));
    expect(requestId('a'.repeat(65))).not.toBe('a'.repeat(65));
    expect(requestId('bad id\n{"x":1}')).toMatch(/^[0-9a-f-]{36}$/);
    expect(requestId(undefined)).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('request lines', () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await close?.();
    close = undefined;
  });

  it('a 5xx gives one error line with the route template and err, never the raw path or query', async () => {
    const { app, lines } = await appWith('info');
    close = () => app.close();
    const res = await app.inject({ method: 'GET', url: '/boom/secret-42?token=abc', headers: { 'x-request-id': 'edge-1' } });
    expect(res.statusCode).toBe(500);
    expect(res.headers['x-request-id']).toBe('edge-1');
    expect(lines).toHaveLength(1);
    const l = lines[0]!;
    expect(l).toMatchObject({
      level: 'error',
      event: 'request_failed',
      req_id: 'edge-1',
      method: 'GET',
      route: '/boom/:id',
      status: 500,
    });
    expect(typeof l.dur_ms).toBe('number');
    expect(l.err).toMatchObject({ type: 'Error', message: 'kaput' });
    expect(l.err.stack).toMatch(/^Error: kaput\n\s+at /);
    const text = JSON.stringify(l);
    expect(text).not.toContain('secret-42');
    expect(text).not.toContain('token=abc');
  });

  it('a 5xx the app answers on purpose (no exception) is one warn line, not an error', async () => {
    const { app, lines } = await appWith('info');
    close = () => app.close();
    const res = await app.inject({ method: 'GET', url: '/upstream/9?x=y' });
    expect(res.statusCode).toBe(502);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ level: 'warn', event: 'request_5xx', route: '/upstream/:id', status: 502 });
    expect(lines[0]!.err).toBeUndefined();
    expect(JSON.stringify(lines)).not.toContain('x=y');
  });

  it('a refused login is one warn line, without the username or the password', async () => {
    const { app, lines } = await appWith('info');
    close = () => app.close();
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: TEST_USER, password: 'wrong-password-xyz' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ level: 'warn', event: 'auth_refused', route: '/api/auth/login', status: 401 });
    const text = JSON.stringify(lines);
    expect(text).not.toContain(TEST_USER);
    expect(text).not.toContain('wrong-password-xyz');
  });

  it('a successful login and the auth gate 401 stay below info; every answer carries X-Request-Id', async () => {
    const { app, lines } = await appWith('debug');
    close = () => app.close();
    const ok = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: TEST_USER, password: TEST_PW } });
    expect(ok.statusCode).toBe(200);
    const gate = await app.inject({ method: 'GET', url: '/api/items', headers: { 'x-request-id': 'gate-1' } });
    expect(gate.statusCode).toBe(401);
    expect(gate.headers['x-request-id']).toBe('gate-1');
    expect(lines.map((l) => [l.level, l.event, l.route, l.status])).toEqual([
      ['debug', 'request', '/api/auth/login', 200],
      ['debug', 'request', '/api/items', 401],
    ]);
    const text = JSON.stringify(lines);
    expect(text).not.toContain('storalex_sid');
    expect(text).not.toContain(TEST_PW);
  });

  it('/healthz is logged at debug only', async () => {
    const info = await appWith('info');
    const r1 = await info.app.inject({ method: 'GET', url: '/healthz' });
    expect(r1.statusCode).toBe(200);
    expect(info.lines).toEqual([]);
    await info.app.close();
    const debug = await appWith('debug');
    close = () => debug.app.close();
    await debug.app.inject({ method: 'GET', url: '/healthz' });
    expect(debug.lines).toHaveLength(1);
    expect(debug.lines[0]).toMatchObject({ level: 'debug', event: 'healthz', route: '/healthz', status: 200 });
  });

  it('an answer slower than 1 s is one warn line', async () => {
    const { app, lines } = await appWith('info');
    close = () => app.close();
    const res = await app.inject({ method: 'GET', url: '/slow/7' });
    expect(res.statusCode).toBe(200);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ level: 'warn', event: 'request_slow', route: '/slow/:id', status: 200 });
    expect(lines[0]!.dur_ms).toBeGreaterThan(SLOW_MS);
  });
});

describe('server process', () => {
  it('startup line on boot (version, port, data dir, config names without values), shutdown line on SIGTERM', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'storalex-boot-'));
    const entry = path.resolve('src/server/index.ts');
    // tsx's loader by absolute URL: the child runs from an empty directory
    const tsx = pathToFileURL(path.resolve('node_modules/tsx/dist/loader.mjs')).href;
    const child = spawn(process.execPath, ['--import', tsx, entry], {
      cwd: dir, // no .env from the repo
      env: {
        PATH: process.env.PATH,
        NODE_ENV: 'test',
        HOST: '127.0.0.1',
        PORT: '0',
        DATA_DIR: dir,
        APP_PEPPER: 'pepper-value-'.padEnd(40, 'p'),
        SESSION_KEY: 'session-value-'.padEnd(40, 's'),
        APP_VERSION: 'v1.2.3-test',
        LOG_LEVEL: 'info',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    const lines = () =>
      out
        .split('\n')
        .filter(Boolean)
        .map((s) => JSON.parse(s) as Line);
    const until = async (pred: () => boolean, what: string) => {
      for (let i = 0; i < 300 && !pred(); i++) await new Promise((r) => setTimeout(r, 50));
      if (!pred()) throw new Error(`timeout waiting for ${what}: stdout=${out} stderr=${err}`);
    };
    try {
      await until(() => lines().some((l) => l.event === 'startup'), 'startup');
      const start = lines().find((l) => l.event === 'startup')!;
      expect(Object.keys(start).slice(0, 6)).toEqual(BASE_FIELDS);
      expect(start).toMatchObject({ level: 'info', service: 'storalex', version: 'v1.2.3-test', port: 0, data_dir_writable: true });
      expect(start.config).toEqual(expect.arrayContaining(['PORT', 'DATA_DIR', 'APP_PEPPER', 'SESSION_KEY', 'APP_VERSION']));
      expect(out).not.toContain('pepper-value');
      expect(out).not.toContain('session-value');
      expect(out).not.toContain(dir); // no path in any line
      // every stdout line is ours (Fastify's own logger, which wrote raw URLs and IPs, is off)
      for (const l of lines()) expect(l.service).toBe('storalex');
      child.kill('SIGTERM');
      const code = await new Promise<number | null>((r) => child.on('exit', r));
      expect(code).toBe(0);
      expect(lines().at(-1)).toMatchObject({ level: 'info', event: 'shutdown', signal: 'SIGTERM' });
      expect(err).toBe('');
    } finally {
      child.kill('SIGKILL');
    }
  }, 30_000);
});

// ---------------------------------------------------------------------------------------------------------
// Background jobs: one line at start and one at end with dur_ms and counts; failures are warn lines with err.

const SA_EMAIL = 'robot-sync@storalex-proj.iam.gserviceaccount.com';
const SA_JSON = JSON.stringify({ type: 'service_account', client_email: SA_EMAIL, private_key: 'not-a-key' });

function sheetConfig() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'storalex-sheet-'));
  return loadConfig({
    NODE_ENV: 'test',
    APP_PEPPER: 'a'.repeat(32),
    SESSION_KEY: 'b'.repeat(32),
    DB_PATH: ':memory:',
    DATA_DIR: dir,
    MEDIA_DIR: dir,
    SHEET_ID: 'sheet-id-123',
    GOOGLE_SERVICE_ACCOUNT_JSON: SA_JSON,
    SHEET_SYNC_DEBOUNCE_MS: '10',
  });
}

/** A fake Sheets client: every call answers `answer()` (a value, or a rejected promise). */
function fakeClient(answer: () => Promise<unknown>): SheetClientFactory {
  return () =>
    ({
      spreadsheets: {
        get: answer,
        batchUpdate: answer,
        values: { batchClear: answer, batchUpdate: answer },
      },
    }) as never;
}

const google403 = () => Promise.reject(Object.assign(new Error('The caller does not have permission'), { code: 403 }));

describe('background jobs', () => {
  it('session prune: start at debug, done at info with dur_ms and the number deleted', () => {
    const repos = createRepos(openDb(':memory:'));
    const uid = repos.users.create('pruner', 'x');
    repos.sessions.create('old-1', uid, '2000-01-01 00:00:00', null);
    repos.sessions.create('old-2', uid, '2000-01-01 00:00:00', null);
    repos.sessions.create('live', uid, '2999-01-01 00:00:00', null);
    const { logger, lines } = capture('debug');
    pruneSessions(repos, logger);
    expect(lines.map((l) => l.event)).toEqual(['session_prune_start', 'session_prune_done']);
    expect(lines[1]).toMatchObject({ level: 'info', deleted: 2 });
    expect(typeof lines[1]!.dur_ms).toBe('number');
    expect(repos.sessions.findValidUser('live')?.id).toBe(uid);
  });

  it('session prune: a failure is one warn line with err, and does not throw', () => {
    const repos = createRepos(openDb(':memory:'));
    repos.sessions.deleteExpired = () => {
      throw new Error('database is locked');
    };
    const { logger, lines } = capture('info');
    expect(() => pruneSessions(repos, logger)).not.toThrow();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ level: 'warn', event: 'session_prune_failed', err: { message: 'database is locked' } });
  });

  it('sheet sync done: info line with dur_ms and the rows pushed per tab', async () => {
    const repos = createRepos(openDb(':memory:'));
    repos.tags.create('fragile', null, 'event');
    repos.tags.create('winter', '#00f', 'event');
    const { logger, lines } = capture('debug');
    const mirror = createSheetMirror(sheetConfig(), repos, logger, fakeClient(async () => ({ data: { sheets: [] } })));
    await mirror.sync('reconcile');
    expect(lines.map((l) => l.event)).toEqual(['sheet_sync_start', 'sheet_sync_done']);
    expect(lines[1]).toMatchObject({ level: 'info', trigger: 'reconcile', rows: { places: 0, items: 0, tags: 2 } });
    expect(typeof lines[1]!.dur_ms).toBe('number');
  });

  it('sheet sync after a change: a Google refusal is one warn line, the service account e-mail never logged', async () => {
    const repos = createRepos(openDb(':memory:'));
    const { logger, lines, raw } = capture('info');
    const mirror = createSheetMirror(sheetConfig(), repos, logger, fakeClient(google403));
    mirror.scheduleSync();
    for (let i = 0; i < 100 && lines.length === 0; i++) await new Promise((r) => setTimeout(r, 20));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ level: 'warn', event: 'sheet_sync_failed', trigger: 'change' });
    expect(lines[0]!.err.message).toContain('403');
    expect(lines[0]!.err.message).toContain('<email>'); // describeError named the account: replaced
    expect(raw.join('')).not.toContain(SA_EMAIL);
    expect(mirror.status().lastError).toContain(SA_EMAIL); // the admin page still shows it (owner-only)
  });
});

describe('config lines', () => {
  afterEach(() => vi.restoreAllMocks());

  it('reconfigureLog re-reads the level and the version (a local .env is loaded after import)', () => {
    const out: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((s) => (out.push(String(s)), true));
    const before = { ...log };
    try {
      reconfigureLog({ LOG_LEVEL: 'warn', APP_VERSION: 'v7.7.7' });
      expect(log.level).toBe('warn');
      log.info('hidden', 'below warn');
      log.warn('shown', 'at warn');
    } finally {
      Object.assign(log, before);
      vi.restoreAllMocks();
    }
    const lines = out.join('').split('\n').filter(Boolean).map((s) => JSON.parse(s) as Line);
    expect(lines.map((l) => l.event)).toEqual(['shown']);
    expect(lines[0]).toMatchObject({ version: 'v7.7.7' });
  });

  it('a missing secret outside production: one config_ephemeral_secret warn line with the name, never a value', () => {
    const out: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((s) => (out.push(String(s)), true));
    const config = loadConfig({ NODE_ENV: 'development', SESSION_KEY: 'b'.repeat(32), DB_PATH: ':memory:' });
    vi.restoreAllMocks();
    const lines = out.join('').split('\n').filter(Boolean).map((s) => JSON.parse(s) as Line);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ level: 'warn', event: 'config_ephemeral_secret', name: 'APP_PEPPER' });
    expect(out.join('')).not.toContain(config.appPepper);
  });
});

// ---------------------------------------------------------------------------------------------------------
// The production process: Fastify's own logger (raw URL + client IP on every request) must stay off.

describe('server process (production)', () => {
  it('every stdout line is ours: no raw path, no query, no IP, no e-mail; the boot sheet sync logs its failure', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'storalex-prod-'));
    const entry = path.resolve('src/server/index.ts');
    const tsx = pathToFileURL(path.resolve('node_modules/tsx/dist/loader.mjs')).href;
    const port = await freePort();
    const child = spawn(process.execPath, ['--import', tsx, entry], {
      cwd: dir,
      env: {
        PATH: process.env.PATH,
        NODE_ENV: 'production',
        HOST: '127.0.0.1',
        PORT: String(port),
        DATA_DIR: dir,
        APP_PEPPER: 'pepper-value-'.padEnd(40, 'p'),
        SESSION_KEY: 'session-value-'.padEnd(40, 's'),
        APP_VERSION: 'v1.2.3-prod',
        LOG_LEVEL: 'info',
        SHEET_ID: 'sheet-id-123',
        GOOGLE_SERVICE_ACCOUNT_JSON: SA_JSON, // unusable key: the boot sync fails without leaving the machine
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    const lines = () =>
      out
        .split('\n')
        .filter(Boolean)
        .map((s) => JSON.parse(s) as Line);
    const until = async (pred: () => boolean, what: string) => {
      for (let i = 0; i < 300 && !pred(); i++) await new Promise((r) => setTimeout(r, 50));
      if (!pred()) throw new Error(`timeout waiting for ${what}: stdout=${out} stderr=${err}`);
    };
    try {
      await until(() => lines().some((l) => l.event === 'startup'), 'startup');
      const start = lines().find((l) => l.event === 'startup')!;
      expect(start).toMatchObject({ env: 'production', version: 'v1.2.3-prod', port, sheet_mirror: true });
      const addr = port;
      const res = await fetch(`http://127.0.0.1:${addr}/api/items?q=needle-query-xyz`);
      expect(res.status).toBe(401);
      const login = await fetch(`http://127.0.0.1:${addr}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: 'nobody', password: 'wrong-password' }),
      });
      expect(login.status).toBeGreaterThanOrEqual(400);
      await until(() => lines().some((l) => l.event === 'auth_refused'), 'auth_refused');
      await until(() => lines().some((l) => l.event === 'sheet_sync_failed'), 'sheet_sync_failed');
      expect(lines().find((l) => l.event === 'sheet_sync_failed')).toMatchObject({ level: 'warn', trigger: 'boot' });
      for (const l of lines()) expect(l.service).toBe('storalex');
      expect(out).not.toContain('needle-query-xyz');
      expect(out).not.toContain('/api/items');
      expect(out).not.toContain('127.0.0.1');
      expect(out).not.toContain(SA_EMAIL);
      expect(out).not.toContain('pepper-value');
      child.kill('SIGTERM');
      expect(await new Promise<number | null>((r) => child.on('exit', r))).toBe(0);
      expect(lines().at(-1)).toMatchObject({ event: 'shutdown', signal: 'SIGTERM' });
    } finally {
      child.kill('SIGKILL');
    }
  }, 30_000);
});

/** A free TCP port on 127.0.0.1. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as net.AddressInfo;
      srv.close(() => resolve(port));
    });
  });
}
