import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import type { CookieSerializeOptions } from '@fastify/cookie';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { S } from '../schemas.js';
import { tx } from '../db/index.js';
import { hashPassword, verifyPassword } from '../auth/password.js';
import { sessionCookieName, newSessionToken, hashToken, expiryFromNow } from '../auth/session.js';
import type { Config } from '../config.js';
import type { User } from '../../shared/types.js';

function cookieOpts(config: Config): CookieSerializeOptions {
  return {
    signed: true,
    httpOnly: true,
    secure: config.isProd, // Secure cookies aren't sent over http://localhost in dev
    sameSite: 'strict',
    path: '/',
    maxAge: config.sessionTtlDays * 24 * 60 * 60,
  };
}

type UserRowLike = { id: number; username: string; created_at: string; last_login_at: string | null };
const publicUser = (u: UserRowLike): User => ({
  id: u.id,
  username: u.username,
  created_at: u.created_at,
  last_login_at: u.last_login_at,
});

export const authRoutes: FastifyPluginAsyncTypebox = async (app) => {
  const { repos, appConfig } = app;
  const cookieName = sessionCookieName(appConfig.isProd);
  // Constant dummy hash so a missing username takes the same time as a wrong
  // password (mitigates a username-enumeration timing oracle).
  const dummyHash = await hashPassword('storalex-dummy-password', appConfig.appPepper);

  function startSession(req: FastifyRequest, reply: FastifyReply, user: UserRowLike) {
    const token = newSessionToken();
    repos.sessions.create(
      hashToken(token),
      user.id,
      expiryFromNow(appConfig.sessionTtlDays),
      req.headers['user-agent'] ?? null,
    );
    repos.users.touchLogin(user.id);
    reply.setCookie(cookieName, token, cookieOpts(appConfig));
    return { user: publicUser(user) };
  }

  // First run: does the instance have no users yet? (public)
  app.get('/api/setup-needed', async () => ({ needed: repos.users.count() === 0 }));

  // First run: create the very first account. Allowed ONLY while no users exist,
  // so this is not a public signup endpoint once set up. (public)
  app.post(
    '/api/auth/setup',
    { schema: S.setup, config: { rateLimit: { max: 10, timeWindow: '15 minutes' } } },
    async (req, reply) => {
      const { username, password } = req.body;
      if (repos.users.count() > 0) return reply.code(403).send({ error: 'setup already completed' });
      const hash = await hashPassword(password, appConfig.appPepper);
      let userId: number | null;
      try {
        // Re-check count inside the transaction to close the create race.
        userId = tx(app.db, () => (repos.users.count() === 0 ? repos.users.create(username, hash) : null));
      } catch (err) {
        if (String((err as Error).message).includes('UNIQUE')) userId = null;
        else throw err;
      }
      if (userId === null) return reply.code(403).send({ error: 'setup already completed' });
      reply.code(201);
      return startSession(req, reply, repos.users.findById(userId)!);
    },
  );

  app.post(
    '/api/auth/login',
    { schema: S.login, config: { rateLimit: { max: 10, timeWindow: '15 minutes' } } },
    async (req, reply) => {
      const { username, password } = req.body;
      const user = repos.users.findByUsername(username);
      const ok = await verifyPassword(user?.password_hash ?? dummyHash, password, appConfig.appPepper);
      if (!user || !ok) return reply.code(401).send({ error: 'invalid credentials' });
      return startSession(req, reply, user);
    },
  );

  // Public (no session needed). The URL allowlist in app.ts's needsAuth() is the
  // single source of truth for which routes are public.
  app.post('/api/auth/logout', async (req, reply) => {
    const raw = req.cookies[cookieName];
    if (raw) {
      const u = req.unsignCookie(raw);
      if (u.valid && u.value) repos.sessions.delete(hashToken(u.value));
    }
    // Must match the set attributes (Secure + Path=/ + no Domain) so a
    // __Host--prefixed cookie is actually cleared by the browser.
    reply.clearCookie(cookieName, { path: '/', secure: appConfig.isProd, httpOnly: true, sameSite: 'strict' });
    return { ok: true };
  });

  app.get('/api/me', async (req) => ({ user: req.user }));
};
