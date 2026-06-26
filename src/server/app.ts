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

export async function buildApp(config: Config, db: DB) {
  const app = Fastify({
    logger: config.env === 'test' ? false : { level: config.isProd ? 'info' : 'debug' },
    trustProxy: config.trustProxy,
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
  app.decorate('sheetMirror', createSheetMirror(config, repos));
  app.decorateRequest('user', null);

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

  app.get('/healthz', async () => {
    db.prepare('SELECT 1').get();
    return { status: 'ok' };
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
