import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { S } from '../schemas.js';
import { generateLabelPdf } from '../lib/pdf.js';
import { looksLikeCode } from '../../shared/ids.js';
import type { ResolveResult } from '../../shared/types.js';

export const codeRoutes: FastifyPluginAsyncTypebox = async (app) => {
  const { repos } = app;

  // Scan endpoint: resolve a code value to its entity (or report unassigned).
  app.get(
    '/api/resolve/:code',
    { schema: S.resolve, config: { rateLimit: { max: 120, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const code = repos.codes.findByValue(req.params.code);
      if (!code) return reply.code(404).send({ error: 'unknown code' });
      const result: ResolveResult = {
        code_value: code.code_value,
        status: code.status,
        entity_type: code.entity_type,
        entity_id: code.entity_id,
      };
      return result;
    },
  );

  // Allocate N pre-printed codes and return a printable PDF label sheet.
  app.post('/api/codes/print', { schema: S.printCodes }, async (req, reply) => {
    const { type, count } = req.body;
    const codes = repos.codes.allocate(type, count);
    const pdf = await generateLabelPdf(codes.map((c) => c.code_value));
    return reply
      .type('application/pdf')
      .header('Content-Disposition', `attachment; filename="storalex-labels-${type}-${count}.pdf"`)
      .send(Buffer.from(pdf));
  });

  // Attach an extra/replacement label to an existing entity (relabel / recovery).
  app.post('/api/codes/assign', { schema: S.assignCode }, async (req, reply) => {
    const { code_value, entity_type, entity_id } = req.body;
    const entity =
      entity_type === 'item' ? repos.items.findById(entity_id) : repos.places.findById(entity_id);
    if (!entity) return reply.code(404).send({ error: `${entity_type} not found` });

    const existing = repos.codes.findByValue(code_value);
    if (existing) {
      if (existing.entity_type !== entity_type) {
        return reply.code(400).send({ error: `code is registered to a ${existing.entity_type}` });
      }
      if (existing.status === 'active' && existing.entity_id != null && existing.entity_id !== entity_id) {
        return reply.code(409).send({ error: 'code already in use by another entity' });
      }
      repos.codes.assign(code_value, entity_type, entity_id);
    } else if (looksLikeCode(code_value)) {
      return reply.code(400).send({ error: 'that code uses the reserved label format; scan the printed label instead' });
    } else {
      repos.codes.createActive(code_value, entity_type, entity_id);
    }
    return { ok: true, codes: repos.codes.listForEntity(entity_type, entity_id) };
  });

  app.get('/api/items/:id/codes', { schema: S.byId }, async (req) =>
    repos.codes.listForEntity('item', req.params.id),
  );
  app.get('/api/places/:id/codes', { schema: S.byId }, async (req) =>
    repos.codes.listForEntity('place', req.params.id),
  );
};
