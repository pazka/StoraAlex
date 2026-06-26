import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { S } from '../schemas.js';
import { hashPassword } from '../auth/password.js';

// User management. Per the owner's request any authenticated user may manage
// users (no admin role). All routes here are behind the auth gate.
export const userRoutes: FastifyPluginAsyncTypebox = async (app) => {
  const { repos, appConfig } = app;

  app.get('/api/users', async () => repos.users.list());

  app.post('/api/users', { schema: S.createUser }, async (req, reply) => {
    const { username, password } = req.body;
    if (repos.users.findByUsername(username)) return reply.code(409).send({ error: 'username already taken' });
    const hash = await hashPassword(password, appConfig.appPepper);
    try {
      const id = repos.users.create(username, hash);
      const u = repos.users.findById(id)!;
      reply.code(201);
      return { id: u.id, username: u.username, created_at: u.created_at, last_login_at: u.last_login_at };
    } catch (err) {
      if (String((err as Error).message).includes('UNIQUE')) {
        return reply.code(409).send({ error: 'username already taken' });
      }
      throw err;
    }
  });

  app.post('/api/users/:id/password', { schema: S.changePassword }, async (req, reply) => {
    const target = repos.users.findById(req.params.id);
    if (!target) return reply.code(404).send({ error: 'user not found' });
    const hash = await hashPassword(req.body.password, appConfig.appPepper);
    repos.users.setPassword(target.id, hash);
    return { ok: true };
  });

  app.delete('/api/users/:id', { schema: S.userId }, async (req, reply) => {
    const target = repos.users.findById(req.params.id);
    if (!target) return reply.code(404).send({ error: 'user not found' });
    // Never allow removing the last account — that would lock everyone out.
    if (repos.users.count() <= 1) return reply.code(400).send({ error: 'cannot delete the last user' });
    repos.users.delete(target.id); // cascades: their sessions are revoked
    return { ok: true };
  });
};
