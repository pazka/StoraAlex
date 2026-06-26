import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { createSheetMirror } from '../lib/sheet.js';

// M7 endpoints are present but the mirror itself is deferred (needs the owner's
// Google Cloud project + service account). They report status / 501 for now.
export const sheetRoutes: FastifyPluginAsyncTypebox = async (app) => {
  const mirror = createSheetMirror(app.appConfig);

  app.get('/api/sheet/status', async () => mirror.status());

  app.post('/api/sheet/export', async (_req, reply) => {
    if (!mirror.configured) {
      return reply.code(501).send({ error: 'sheet mirror not configured (M7 deferred)' });
    }
    try {
      await mirror.exportNow();
      return { ok: true };
    } catch (err) {
      return reply.code(501).send({ error: (err as Error).message });
    }
  });

  app.post('/api/sheet/import', async (_req, reply) =>
    reply.code(501).send({ error: 'sheet import not implemented (M7 deferred)' }),
  );
};
