import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { S } from '../schemas.js';
import { tx } from '../db/index.js';
import { looksLikeCode } from '../../shared/ids.js';
import type { Repos } from '../db/repos.js';
import type { ItemDetail } from '../../shared/types.js';

function itemDetail(repos: Repos, id: number): ItemDetail | undefined {
  const item = repos.items.findById(id);
  if (!item) return undefined;
  return {
    ...item,
    tags: repos.items.tags(id),
    location_path: item.location_place_id != null ? repos.places.breadcrumb(item.location_place_id) : [],
  };
}

export const itemRoutes: FastifyPluginAsyncTypebox = async (app) => {
  const { repos } = app;

  app.get('/api/items', { schema: S.itemsQuery }, async (req) => {
    const q = req.query;
    return repos.items.list({ tag: q.tag, place: q.place, status: q.status, q: q.q });
  });

  app.get('/api/items/:id', { schema: S.byId }, async (req, reply) => {
    const detail = itemDetail(repos, req.params.id);
    if (!detail) return reply.code(404).send({ error: 'item not found' });
    return detail;
  });

  app.post('/api/items', { schema: S.createItem }, async (req, reply) => {
    const b = req.body;
    const userId = req.user?.id ?? null;
    const method = b.method ?? 'manual';

    if (b.location_place_id != null && !repos.places.findById(b.location_place_id)) {
      return reply.code(400).send({ error: 'location_place_id not found' });
    }
    if (b.photo_id != null && !repos.photos.find(b.photo_id)) {
      return reply.code(400).send({ error: 'photo_id not found' });
    }

    // Decide how the code is attached before opening the write transaction.
    let codeAction: 'assign' | 'create' | 'allocate' = 'allocate';
    if (b.code_value) {
      const existing = repos.codes.findByValue(b.code_value);
      if (existing) {
        if (existing.entity_type !== 'item') return reply.code(400).send({ error: 'code is registered to a place' });
        if (existing.status !== 'unassigned' || existing.entity_id != null) {
          return reply.code(409).send({ error: 'code already in use' });
        }
        codeAction = 'assign';
      } else if (looksLikeCode(b.code_value)) {
        // A typed code in the reserved OBJ-/PLC- sequence format would later
        // collide with allocate() and wedge the counter. Only pre-printed codes
        // (already present as 'unassigned') may use that format.
        return reply.code(400).send({ error: 'that code uses the reserved label format; scan the printed label instead' });
      } else {
        codeAction = 'create';
      }
    }

    const id = tx(app.db, () => {
      const codeValue = codeAction === 'allocate' ? repos.codes.allocate('item', 1)[0]!.code_value : b.code_value!;
      const newId = repos.items.create({
        code_display: codeValue,
        name: b.name,
        photo_id: b.photo_id ?? null,
        location_place_id: b.location_place_id ?? null,
        notes: b.notes ?? null,
        price: b.price ?? null,
      });
      if (codeAction === 'create') repos.codes.createActive(codeValue, 'item', newId);
      else repos.codes.assign(codeValue, 'item', newId);

      repos.movements.log({
        user_id: userId,
        entity_type: 'item',
        entity_id: newId,
        action: 'created',
        from_place_id: null,
        to_place_id: null,
        method,
        note: null,
      });
      if (b.location_place_id != null) {
        repos.movements.log({
          user_id: userId,
          entity_type: 'item',
          entity_id: newId,
          action: 'moved_in',
          from_place_id: null,
          to_place_id: b.location_place_id,
          method,
          note: null,
        });
      }
      return newId;
    });

    reply.code(201);
    return itemDetail(repos, id);
  });

  app.patch('/api/items/:id', { schema: S.patchItem }, async (req, reply) => {
    const item = repos.items.findById(req.params.id);
    if (!item) return reply.code(404).send({ error: 'item not found' });
    if (req.body.photo_id != null && !repos.photos.find(req.body.photo_id)) {
      return reply.code(400).send({ error: 'photo_id not found' });
    }
    tx(app.db, () => {
      if (!repos.items.update(item.id, req.body)) return; // nothing to change → no audit entry
      repos.movements.log({
        user_id: req.user?.id ?? null,
        entity_type: 'item',
        entity_id: item.id,
        action: 'edited',
        from_place_id: null,
        to_place_id: null,
        method: 'manual',
        note: null,
      });
    });
    return itemDetail(repos, item.id);
  });

  app.post('/api/items/:id/move', { schema: S.moveItem }, async (req, reply) => {
    const item = repos.items.findById(req.params.id);
    if (!item) return reply.code(404).send({ error: 'item not found' });
    const to = req.body.to_place_id;
    if (to != null && !repos.places.findById(to)) {
      return reply.code(400).send({ error: 'to_place_id not found' });
    }
    const from = item.location_place_id;
    const method = req.body.method ?? 'manual';
    const action = to == null ? 'moved_out' : from == null ? 'moved_in' : 'relocated';
    tx(app.db, () => {
      repos.items.setLocation(item.id, to);
      repos.movements.log({
        user_id: req.user?.id ?? null,
        entity_type: 'item',
        entity_id: item.id,
        action,
        from_place_id: from,
        to_place_id: to,
        method,
        note: req.body.note ?? null,
      });
    });
    return itemDetail(repos, item.id);
  });

  // Move many objects to one place (or out) at once.
  app.post('/api/items/bulk-move', { schema: S.bulkMoveItems }, async (req, reply) => {
    const { item_ids, to_place_id } = req.body;
    const method = req.body.method ?? 'manual';
    const userId = req.user?.id ?? null;
    if (to_place_id != null && !repos.places.findById(to_place_id)) {
      return reply.code(400).send({ error: 'to_place_id not found' });
    }
    let moved = 0;
    tx(app.db, () => {
      for (const id of item_ids) {
        const item = repos.items.findById(id);
        if (!item) continue; // skip unknown ids silently
        const from = item.location_place_id;
        if (from === to_place_id) continue; // already there → no-op
        const action = to_place_id == null ? 'moved_out' : from == null ? 'moved_in' : 'relocated';
        repos.items.setLocation(item.id, to_place_id);
        repos.movements.log({
          user_id: userId,
          entity_type: 'item',
          entity_id: item.id,
          action,
          from_place_id: from,
          to_place_id,
          method,
          note: req.body.note ?? null,
        });
        moved++;
      }
    });
    return { moved };
  });

  app.post('/api/items/:id/tags', { schema: S.itemTag }, async (req, reply) => {
    const item = repos.items.findById(req.params.id);
    if (!item) return reply.code(404).send({ error: 'item not found' });
    if (!repos.tags.findById(req.body.tag_id)) return reply.code(400).send({ error: 'tag not found' });
    const added = repos.items.addTag(item.id, req.body.tag_id);
    if (added) {
      repos.movements.log({
        user_id: req.user?.id ?? null,
        entity_type: 'item',
        entity_id: item.id,
        action: 'tagged',
        from_place_id: null,
        to_place_id: null,
        method: 'manual',
        note: null,
      });
    }
    return itemDetail(repos, item.id);
  });

  app.delete('/api/items/:id/tags/:tagId', { schema: S.itemTagDelete }, async (req, reply) => {
    const item = repos.items.findById(req.params.id);
    if (!item) return reply.code(404).send({ error: 'item not found' });
    const removed = repos.items.removeTag(item.id, req.params.tagId);
    if (removed) {
      repos.movements.log({
        user_id: req.user?.id ?? null,
        entity_type: 'item',
        entity_id: item.id,
        action: 'untagged',
        from_place_id: null,
        to_place_id: null,
        method: 'manual',
        note: null,
      });
    }
    return itemDetail(repos, item.id);
  });
};
