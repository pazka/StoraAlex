import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { tx } from '../db/index.js';
import { looksLikeCode } from '../../shared/ids.js';
import { buildWorkbook, readWorkbook, type ImportData } from '../lib/excel.js';
import type { Repos } from '../db/repos.js';
import type { TagKind } from '../../shared/types.js';

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

const truthy = (s: string | undefined): boolean => ['yes', 'y', '1', 'true'].includes((s ?? '').trim().toLowerCase());
const asKind = (s: string | undefined): TagKind => (s === 'event' || s === 'flag' ? s : 'other');
const asPrice = (s: string | undefined): number | null => {
  const v = (s ?? '').trim();
  if (v === '') return null;
  const n = Number(v.replace(',', '.'));
  return Number.isFinite(n) && n >= 0 ? n : null;
};

function setItemTags(repos: Repos, itemId: number, tagsCell: string | undefined) {
  repos.items.clearTags(itemId);
  for (const name of (tagsCell ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
    let tag = repos.tags.findByName(name);
    if (!tag) tag = repos.tags.findById(repos.tags.create(name, null, 'other'));
    if (tag) repos.items.addTag(itemId, tag.id);
  }
}

interface Summary {
  tagsCreated: number;
  placesCreated: number;
  placesUpdated: number;
  itemsCreated: number;
  itemsUpdated: number;
  errors: string[];
}

/** Idempotent upsert keyed on the QR code. Must run inside a transaction. */
export function importData(repos: Repos, data: ImportData): Summary {
  const s: Summary = { tagsCreated: 0, placesCreated: 0, placesUpdated: 0, itemsCreated: 0, itemsUpdated: 0, errors: [] };

  for (const row of data.tags) {
    const name = (row.name ?? '').trim();
    if (!name) continue;
    if (!repos.tags.findByName(name)) {
      repos.tags.create(name, (row.color ?? '').trim() || null, asKind(row.kind));
      s.tagsCreated++;
    }
  }

  // Places pass 1: create/update by code (parents resolved in pass 2).
  for (const row of data.places) {
    const code = (row.code ?? '').trim();
    const name = (row.name ?? '').trim();
    if (!name) {
      s.errors.push(`place ${code || '(no code)'}: missing name — skipped`);
      continue;
    }
    const existing = code ? repos.places.findByCode(code) : undefined;
    if (existing) {
      repos.places.update(existing.id, { name, info: (row.info ?? '').trim() || null });
      repos.places.setArchived(existing.id, truthy(row.archived));
      s.placesUpdated++;
    } else {
      const codeVal = code || repos.codes.allocate('place', 1)[0]!.code_value;
      const id = repos.places.create({ code_display: codeVal, name, photo_id: null, info: (row.info ?? '').trim() || null, parent_place_id: null });
      attachCode(repos, codeVal, 'place', id);
      if (truthy(row.archived)) repos.places.setArchived(id, true);
      s.placesCreated++;
    }
  }
  // Places pass 2: parents.
  for (const row of data.places) {
    const code = (row.code ?? '').trim();
    if (!code) continue;
    const place = repos.places.findByCode(code);
    if (!place) continue;
    const parentCode = (row.parent_code ?? '').trim();
    const parent = parentCode ? repos.places.findByCode(parentCode) : undefined;
    repos.places.setParent(place.id, parent && parent.id !== place.id ? parent.id : null);
  }

  for (const row of data.items) {
    const code = (row.code ?? '').trim();
    const name = (row.name ?? '').trim();
    if (!name) {
      s.errors.push(`item ${code || '(no code)'}: missing name — skipped`);
      continue;
    }
    const placeCode = (row.place_code ?? '').trim();
    const loc = placeCode ? (repos.places.findByCode(placeCode)?.id ?? null) : null;
    const price = asPrice(row.price);
    const notes = (row.notes ?? '').trim() || null;
    const existing = code ? repos.items.findByCode(code) : undefined;
    if (existing) {
      repos.items.update(existing.id, { name, notes, price });
      repos.items.setLocation(existing.id, loc);
      repos.items.setArchived(existing.id, truthy(row.archived));
      setItemTags(repos, existing.id, row.tags);
      s.itemsUpdated++;
    } else {
      const codeVal = code || repos.codes.allocate('item', 1)[0]!.code_value;
      const id = repos.items.create({ code_display: codeVal, name, photo_id: null, location_place_id: loc, notes, price });
      attachCode(repos, codeVal, 'item', id);
      if (truthy(row.archived)) repos.items.setArchived(id, true);
      setItemTags(repos, id, row.tags);
      s.itemsCreated++;
    }
  }
  return s;
}

function attachCode(repos: Repos, codeVal: string, entityType: 'item' | 'place', entityId: number) {
  const existing = repos.codes.findByValue(codeVal);
  if (existing) {
    if (existing.entity_type === entityType && existing.status === 'unassigned') repos.codes.assign(codeVal, entityType, entityId);
    // else: code already belongs elsewhere — leave it; entity still keeps code_display
  } else if (looksLikeCode(codeVal) || codeVal) {
    repos.codes.createActive(codeVal, entityType, entityId);
  }
}

export const dataRoutes: FastifyPluginAsyncTypebox = async (app) => {
  const { repos } = app;

  app.get('/api/export.xlsx', async (_req, reply) => {
    const buf = await buildWorkbook({
      places: repos.places.exportRows(),
      items: repos.items.exportRows(),
      tags: repos.tags.list().map((t) => ({ name: t.name, color: t.color, kind: t.kind })),
    });
    return reply
      .type(XLSX_MIME)
      .header('Content-Disposition', 'attachment; filename="storalex-export.xlsx"')
      .send(buf);
  });

  app.post('/api/import.xlsx', async (req, reply) => {
    let file;
    try {
      file = await req.file();
    } catch {
      return reply.code(400).send({ error: 'invalid upload' });
    }
    if (!file) return reply.code(400).send({ error: 'no file provided' });
    let buf: Buffer;
    try {
      buf = await file.toBuffer();
    } catch {
      return reply.code(413).send({ error: 'file too large' });
    }
    let parsed: ImportData;
    try {
      parsed = await readWorkbook(buf);
    } catch {
      return reply.code(400).send({ error: 'could not read the workbook (is it a valid .xlsx with Places/Items/Tags sheets?)' });
    }
    return tx(app.db, () => importData(repos, parsed));
  });
};
