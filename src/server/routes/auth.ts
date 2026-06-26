import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import type { CookieSerializeOptions } from '@fastify/cookie';
import { S } from '../schemas.js';
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

const publicUser = (u: { id: number; username: string; created_at: string; last_login_at: string | null }): User => ({
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

  app.post(
    '/api/auth/login',
    { schema: S.login, config: { rateLimit: { max: 10, timeWindow: '15 minutes' } } },
    async (req, reply) => {
      const { username, password } = req.body;
      const user = repos.users.findByUsername(username);
      const ok = await verifyPassword(user?.password_hash ?? dummyHash, password, appConfig.appPepper);
      if (!user || !ok) {
        return reply.code(401).send({ error: 'invalid credentials' });
      }
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
    },
  );

  // Public (no session needed). The URL allowlist in app.ts's needsAuth() is the
  // single source of truth for which routes are public — no route-config flag.
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
