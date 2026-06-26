import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';

// Read-only Google Sheet mirror (M7). Status + a manual "sync now"; automatic
// debounced syncing happens via the onResponse hook in app.ts.
export const sheetRoutes: FastifyPluginAsyncTypebox = async (app) => {
  app.get('/api/sheet/status', async () => app.sheetMirror.status());

  app.post('/api/sheet/export', async (_req, reply) => {
    if (!app.sheetMirror.configured) {
      return reply
        .code(501)
        .send({ error: 'Google Sheet not configured — set SHEET_ID and GOOGLE_SERVICE_ACCOUNT_JSON' });
    }
    try {
      await app.sheetMirror.exportNow();
      return { ok: true, status: app.sheetMirror.status() };
    } catch (err) {
      return reply.code(502).send({ error: `sync failed: ${(err as Error).message}` });
    }
  });
};
