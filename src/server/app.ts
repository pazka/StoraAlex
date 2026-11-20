import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import multipart from '@fastify/multipart';
import staticPlugin from '@fastify/static';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import fs from 'node:fs';
import path from 'node:path';

import type { Config } from './config.js';
import type { DB } from './db/index.js';
import { createRepos } from './db/repos.js';
import { createSheetMirror } from './lib/sheet.js';
import { sessionCookieName, hashToken } from './auth/session.js';
import { errField, log, requestId, silentLogger, SLOW_MS, type Fields, type Logger } from './lib/log.js';

import { authRoutes } from './routes/auth.js';
import { userRoutes } from './routes/users.js';
import { itemRoutes } from './routes/items.js';
import { placeRoutes } from './routes/places.js';
import { codeRoutes } from './routes/codes.js';
import { tagRoutes } from './routes/tags.js';
import { movementRoutes } from './routes/movements.js';
import { mediaRoutes } from './routes/media.js';
import { sheetRoutes } from './routes/sheet.js';
import { dataRoutes } from './routes/data.js';

/** Requests that don't require an authenticated session. */
function needsAuth(url: string): boolean {
  const p = url.split('?')[0] ?? url;
  if (
    p === '/api/auth/login' ||
    p === '/api/auth/logout' ||
    p === '/api/auth/setup' || // first-run account creation (guarded by user count == 0)
    p === '/api/setup-needed' ||
    p === '/healthz'
  ) {
    return false;
  }
  return p.startsWith('/api/') || p.startsWith('/media/');
}

function writableDir(dir: string): boolean {
  try {
    if (!fs.statSync(dir).isDirectory()) return false;
    fs.accessSync(dir, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Fastify >= 5.12 no longer accepts a hop count (a number now trusts nothing).
 * TRUST_PROXY=<n> keeps its documented meaning — trust the n closest hops, as
 * fastify did before — via the equivalent trust function.
 */
function fastifyTrustProxy(tp: Config['trustProxy']) {
  if (typeof tp !== 'number') return tp;
  return (_address: string, hop: number) => hop < tp;
}

export interface BuildOptions {
  /** Where the request lines go (default: stdout, or nothing in tests). */
  logger?: Logger;
}

export async function buildApp(config: Config, db: DB, opts: BuildOptions = {}) {
  const logger = opts.logger ?? (config.env === 'test' ? silentLogger : log);
  const app = Fastify({
    // Fastify's own logger stays off: it wrote every request with its raw URL and the client IP.
    // Requests are logged by the hooks below, in the hosh.it format (lib/log.ts).
    logger: false,
    // X-Request-Id from the edge when it is a plain token of at most 64 chars, else a new one
    requestIdHeader: false,
    genReqId: (req) => requestId(req.headers['x-request-id']),
    trustProxy: fastifyTrustProxy(config.trustProxy),
    routerOptions: { caseSensitive: true }, // pin the default the auth gate's path matching relies on
    bodyLimit: 1024 * 1024, // 1 MiB JSON; image bytes go through multipart instead
    // removeAdditional:false so additionalProperties:false on our schemas REJECTS
    // unknown fields (400) rather than silently stripping them (SPEC §7.4).
    ajv: { customOptions: { removeAdditional: false, coerceTypes: 'array', useDefaults: true } },
  }).withTypeProvider<TypeBoxTypeProvider>();

  const repos = createRepos(db);
  const cookieName = sessionCookieName(config.isProd);
  app.decorate('appConfig', config);
  app.decorate('db', db);
  app.decorate('repos', repos);
  app.decorate('sheetMirror', createSheetMirror(config, repos, logger));
  app.decorateRequest('user', null);
  app.decorate('logger', logger);

  // Logging standard (hosh-management AGENTS.md section 11). Registered first, so every answer, a 401
  // of the auth gate included, carries X-Request-Id and goes through the request line below.
  const failures = new WeakMap<object, unknown>();
  app.addHook('onRequest', async (req, reply) => {
    reply.header('X-Request-Id', req.id);
  });
  app.addHook('onError', async (req, _reply, err) => {
    failures.set(req, err);
  });
  // One line per answer only when it matters: a 5xx (error, with `err`), a 4xx on an auth route (warn),
  // a slow answer (warn); anything else at debug; /healthz never above debug. `route` is the route
  // template, never the raw path or its query string.
  app.addHook('onResponse', async (req, reply) => {
    const route = req.routeOptions.url ?? '(none)';
    const status = reply.statusCode;
    const fields: Fields = { req_id: req.id, method: req.method, route, status, dur_ms: Math.round(reply.elapsedTime) };
    if (route === '/healthz') return logger.debug('healthz', 'healthz', fields);
    if (status >= 500) {
      const failure = failures.get(req);
      return logger.error(
        'request_failed',
        'server error',
        failure === undefined ? fields : { ...fields, ...errField(failure, [req.url, req.url.split('?')[0] ?? '']) },
      );
    }
    if (status >= 400 && route.startsWith('/api/auth/')) return logger.warn('auth_refused', 'auth request refused', fields);
    if ((fields.dur_ms as number) > SLOW_MS) return logger.warn('request_slow', 'slow request', fields);
    logger.debug('request', 'request', fields);
  });

  await app.register(cookie, { secret: config.sessionKey });
  await app.register(helmet, {
    contentSecurityPolicy: config.isProd
      ? {
          directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'"],
            styleSrc: ["'self'", "'unsafe-inline'"],
            imgSrc: ["'self'", 'data:', 'blob:'],
            connectSrc: ["'self'"],
            workerSrc: ["'self'"],
            manifestSrc: ["'self'"],
            objectSrc: ["'none'"],
            frameAncestors: ["'none'"],
            baseUri: ["'self'"],
            formAction: ["'self'"],
          },
        }
      : false,
  });
  await app.register(rateLimit, { max: 300, timeWindow: '1 minute' });
  await app.register(multipart, {
    limits: { fileSize: config.maxUploadBytes, files: 1, fields: 10 },
  });

  // Auth gate: every /api and /media route (except the allowlist) needs a
  // valid server-side session resolved from the signed cookie.
  app.addHook('onRequest', async (req, reply) => {
    if (!needsAuth(req.url)) return;
    const raw = req.cookies?.[cookieName];
    if (raw) {
      const u = req.unsignCookie(raw);
      if (u.valid && u.value) {
        const user = repos.sessions.findValidUser(hashToken(u.value));
        if (user) {
          req.user = user;
          return;
        }
      }
    }
    return reply.code(401).send({ error: 'unauthorized' });
  });

  // After any successful inventory-changing request, debounce a push to the
  // Google Sheet mirror. No-op unless the mirror is configured.
  app.addHook('onResponse', async (req, reply) => {
    if (!app.sheetMirror.configured) return;
    if (req.method !== 'POST' && req.method !== 'PATCH' && req.method !== 'DELETE') return;
    if (reply.statusCode >= 400) return;
    const p = req.url.split('?')[0] ?? req.url;
    if (!p.startsWith('/api/') || p.startsWith('/api/sheet') || p.startsWith('/api/auth') || p.startsWith('/api/media')) {
      return;
    }
    app.sheetMirror.scheduleSync();
  });

  // Capability health (box standard): the DB answers and the storage the app
  // writes to (DB directory, media directory) is a writable directory. Used by
  // the image HEALTHCHECK and by hosh-deploy before a release goes live.
  // Never exposes paths, counts of user data or secrets.
  app.get('/healthz', async (_req, reply) => {
    let migrations: number;
    try {
      migrations = (db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get() as { n: number }).n;
    } catch {
      return reply.code(503).send({ status: 'error', db: 'error' });
    }
    const dirs = [
      config.dbPath === ':memory:' ? null : path.dirname(config.dbPath),
      // created on the first upload: until then its parent must be writable
      fs.existsSync(config.mediaDir) ? config.mediaDir : path.dirname(config.mediaDir),
    ];
    for (const dir of dirs) {
      if (dir && !writableDir(dir)) return reply.code(503).send({ status: 'error', db: 'ok', storage: 'not writable' });
    }
    return { status: 'ok', db: 'ok', migrations, storage: 'writable' };
  });

  await app.register(authRoutes);
  await app.register(userRoutes);
  await app.register(itemRoutes);
  await app.register(placeRoutes);
  await app.register(codeRoutes);
  await app.register(tagRoutes);
  await app.register(movementRoutes);
  await app.register(mediaRoutes);
  await app.register(sheetRoutes);
  await app.register(dataRoutes);

  // Serve the built PWA (production / after `npm run build`). In dev, Vite
  // serves the client and proxies the API, so this block is skipped.
  const clientDir = path.resolve('dist/client');
  if (fs.existsSync(clientDir)) {
    await app.register(staticPlugin, { root: clientDir, prefix: '/', wildcard: false });
    app.setNotFoundHandler((req, reply) => {
      if (req.method === 'GET' && !req.url.startsWith('/api') && !req.url.startsWith('/media')) {
        return reply.type('text/html').sendFile('index.html');
      }
      return reply.code(404).send({ error: 'not found' });
    });
  }

  return app;
}
