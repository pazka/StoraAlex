import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { S } from '../schemas.js';

export const tagRoutes: FastifyPluginAsyncTypebox = async (app) => {
  const { repos } = app;

  app.get('/api/tags', async () => repos.tags.list());

  app.post('/api/tags', { schema: S.createTag }, async (req, reply) => {
    const { name, color, kind } = req.body;
    try {
      const id = repos.tags.create(name, color ?? null, kind ?? 'other');
      reply.code(201);
      return repos.tags.findById(id);
    } catch (err) {
      if (String((err as Error).message).includes('UNIQUE')) {
        return reply.code(409).send({ error: 'a tag with that name already exists' });
      }
      throw err;
    }
  });
};
