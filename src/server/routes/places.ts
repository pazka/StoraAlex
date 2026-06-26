import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import fs from 'node:fs/promises';
import path from 'node:path';
import { S } from '../schemas.js';
import { tx } from '../db/index.js';
import { looksLikeCode } from '../../shared/ids.js';
import type { Repos } from '../db/repos.js';
import type { PlaceDetail } from '../../shared/types.js';

function placeDetail(repos: Repos, id: number): PlaceDetail | undefined {
  const place = repos.places.findById(id);
  if (!place) return undefined;
  return {
    ...place,
    parent_path: place.parent_place_id != null ? repos.places.breadcrumb(place.parent_place_id) : [],
    child_places: repos.places.children(id),
    items: repos.items.list({ place: id }),
    tags: repos.places.tags(id),
  };
}

export const placeRoutes: FastifyPluginAsyncTypebox = async (app) => {
  const { repos } = app;

  app.get('/api/places', { schema: S.placesQuery }, async (req) => {
    const q = req.query;
    if (q.archived) return repos.places.list({ archived: true });
    const parent = q.root ? null : typeof q.parent === 'number' ? q.parent : undefined;
    return repos.places.list({ parent, tag: q.tag });
  });

  app.get('/api/places/:id', { schema: S.byId }, async (req, reply) => {
    const detail = placeDetail(repos, req.params.id);
    if (!detail) return reply.code(404).send({ error: 'place not found' });
    return detail;
  });

  app.post('/api/places', { schema: S.createPlace }, async (req, reply) => {
    const b = req.body;
    const userId = req.user?.id ?? null;
    const method = b.method ?? 'manual';

    if (b.parent_place_id != null && !repos.places.findById(b.parent_place_id)) {
      return reply.code(400).send({ error: 'parent_place_id not found' });
    }
    if (b.photo_id != null && !repos.photos.find(b.photo_id)) {
      return reply.code(400).send({ error: 'photo_id not found' });
    }

    let codeAction: 'assign' | 'create' | 'allocate' = 'allocate';
    if (b.code_value) {
      const existing = repos.codes.findByValue(b.code_value);
      if (existing) {
        if (existing.entity_type !== 'place') return reply.code(400).send({ error: 'code is registered to an item' });
        if (existing.status !== 'unassigned' || existing.entity_id != null) {
          return reply.code(409).send({ error: 'code already in use' });
        }
        codeAction = 'assign';
      } else if (looksLikeCode(b.code_value)) {
        return reply.code(400).send({ error: 'that code uses the reserved label format; scan the printed label instead' });
      } else {
        codeAction = 'create';
      }
    }

    const id = tx(app.db, () => {
      const codeValue = codeAction === 'allocate' ? repos.codes.allocate('place', 1)[0]!.code_value : b.code_value!;
      const newId = repos.places.create({
        code_display: codeValue,
        name: b.name,
        photo_id: b.photo_id ?? null,
        info: b.info ?? null,
        parent_place_id: b.parent_place_id ?? null,
      });
      if (codeAction === 'create') repos.codes.createActive(codeValue, 'place', newId);
      else repos.codes.assign(codeValue, 'place', newId);

      repos.movements.log({
        user_id: userId,
        entity_type: 'place',
        entity_id: newId,
        action: 'created',
        from_place_id: null,
        to_place_id: b.parent_place_id ?? null,
        method,
        note: null,
      });
      return newId;
    });

    reply.code(201);
    return placeDetail(repos, id);
  });

  app.patch('/api/places/:id', { schema: S.patchPlace }, async (req, reply) => {
    const place = repos.places.findById(req.params.id);
    if (!place) return reply.code(404).send({ error: 'place not found' });
    if (req.body.photo_id != null && !repos.photos.find(req.body.photo_id)) {
      return reply.code(400).send({ error: 'photo_id not found' });
    }
    tx(app.db, () => {
      if (!repos.places.update(place.id, req.body)) return; // nothing to change → no audit entry
      repos.movements.log({
        user_id: req.user?.id ?? null,
        entity_type: 'place',
        entity_id: place.id,
        action: 'edited',
        from_place_id: null,
        to_place_id: null,
        method: 'manual',
        note: null,
      });
    });
    return placeDetail(repos, place.id);
  });

  app.post('/api/places/:id/move', { schema: S.movePlace }, async (req, reply) => {
    const place = repos.places.findById(req.params.id);
    if (!place) return reply.code(404).send({ error: 'place not found' });
    const newParent = req.body.parent_place_id;
    if (newParent != null) {
      if (newParent === place.id) return reply.code(400).send({ error: 'a place cannot be its own parent' });
      if (!repos.places.findById(newParent)) return reply.code(400).send({ error: 'parent_place_id not found' });
      // Reject if the new parent is the place itself or one of its descendants.
      if (repos.places.isAncestorOrSelf(place.id, newParent)) {
        return reply.code(400).send({ error: 'cannot move a place under its own descendant' });
      }
    }
    const from = place.parent_place_id;
    tx(app.db, () => {
      repos.places.setParent(place.id, newParent);
      repos.movements.log({
        user_id: req.user?.id ?? null,
        entity_type: 'place',
        entity_id: place.id,
        action: 'relocated',
        from_place_id: from,
        to_place_id: newParent,
        method: req.body.method ?? 'manual',
        note: req.body.note ?? null,
      });
    });
    return placeDetail(repos, place.id);
  });

  app.post('/api/places/:id/tags', { schema: S.itemTag }, async (req, reply) => {
    const place = repos.places.findById(req.params.id);
    if (!place) return reply.code(404).send({ error: 'place not found' });
    if (!repos.tags.findById(req.body.tag_id)) return reply.code(400).send({ error: 'tag not found' });
    const added = repos.places.addTag(place.id, req.body.tag_id);
    if (added) {
      repos.movements.log({
        user_id: req.user?.id ?? null,
        entity_type: 'place',
        entity_id: place.id,
        action: 'tagged',
        from_place_id: null,
        to_place_id: null,
        method: 'manual',
        note: null,
      });
    }
    return placeDetail(repos, place.id);
  });

  app.delete('/api/places/:id/tags/:tagId', { schema: S.itemTagDelete }, async (req, reply) => {
    const place = repos.places.findById(req.params.id);
    if (!place) return reply.code(404).send({ error: 'place not found' });
    const removed = repos.places.removeTag(place.id, req.params.tagId);
    if (removed) {
      repos.movements.log({
        user_id: req.user?.id ?? null,
        entity_type: 'place',
        entity_id: place.id,
        action: 'untagged',
        from_place_id: null,
        to_place_id: null,
        method: 'manual',
        note: null,
      });
    }
    return placeDetail(repos, place.id);
  });

  app.post('/api/places/:id/archive', { schema: S.byId }, async (req, reply) => {
    const place = repos.places.findById(req.params.id);
    if (!place) return reply.code(404).send({ error: 'place not found' });
    tx(app.db, () => {
      repos.places.setArchived(place.id, true);
      repos.movements.log({
        user_id: req.user?.id ?? null,
        entity_type: 'place',
        entity_id: place.id,
        action: 'archived',
        from_place_id: null,
        to_place_id: null,
        method: 'manual',
        note: null,
      });
    });
    return { ok: true };
  });

  app.post('/api/places/:id/unarchive', { schema: S.byId }, async (req, reply) => {
    const place = repos.places.findById(req.params.id);
    if (!place) return reply.code(404).send({ error: 'place not found' });
    tx(app.db, () => {
      repos.places.setArchived(place.id, false);
      repos.movements.log({
        user_id: req.user?.id ?? null,
        entity_type: 'place',
        entity_id: place.id,
        action: 'unarchived',
        from_place_id: null,
        to_place_id: null,
        method: 'manual',
        note: null,
      });
    });
    return { ok: true };
  });

  // Permanent delete — only for archived places. Cascades to nested places and
  // the objects inside them (and their codes/tags/photos).
  app.delete('/api/places/:id', { schema: S.byId }, async (req, reply) => {
    const place = repos.places.findById(req.params.id);
    if (!place) return reply.code(404).send({ error: 'place not found' });
    if (place.archived_at == null) {
      return reply.code(400).send({ error: 'archive the place before deleting it permanently' });
    }
    const result = tx(app.db, () => repos.hardDeletePlaceSubtree(place.id));
    for (const p of result.photoPaths) {
      await fs.unlink(path.join(app.appConfig.mediaDir, p)).catch(() => {});
    }
    return { ok: true, placesDeleted: result.placesDeleted, itemsDeleted: result.itemsDeleted };
  });
};
