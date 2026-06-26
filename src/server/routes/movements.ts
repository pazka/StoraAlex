import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { S } from '../schemas.js';

export const movementRoutes: FastifyPluginAsyncTypebox = async (app) => {
  const { repos } = app;

  app.get('/api/movements', { schema: S.movementsQuery }, async (req) => {
    const q = req.query;
    return repos.movements.list({
      entity_type: q.entity_type,
      entity_id: q.entity_id,
      from: q.from,
      to: q.to,
      limit: q.limit,
    });
  });
};
