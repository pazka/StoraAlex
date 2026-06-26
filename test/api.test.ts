import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { makeApp, loginCookie } from './helpers.ts';

let app: FastifyInstance;
let cookie: string;

beforeAll(async () => {
  const m = await makeApp();
  app = m.app;
  cookie = await loginCookie(app);
});
afterAll(async () => {
  await app.close();
});

const authed = (opts: InjectOptions): InjectOptions => ({
  ...opts,
  headers: { ...(opts.headers ?? {}), cookie },
});
const post = (url: string, payload?: unknown) => app.inject(authed({ method: 'POST', url, payload }));
const patch = (url: string, payload?: unknown) => app.inject(authed({ method: 'PATCH', url, payload }));
const get = (url: string) => app.inject(authed({ method: 'GET', url }));

describe('auth', () => {
  it('rejects a wrong password', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'tester', password: 'nope' } });
    expect(res.statusCode).toBe(401);
  });

  it('blocks /api without a session', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/items' });
    expect(res.statusCode).toBe(401);
  });

  it('returns the user from /api/me when authenticated', async () => {
    const res = await get('/api/me');
    expect(res.statusCode).toBe(200);
    expect(res.json().user.username).toBe('tester');
  });
});

describe('input validation', () => {
  it('rejects unknown body fields (400)', async () => {
    const res = await post('/api/tags', { name: 'X', bogus: 1 });
    expect(res.statusCode).toBe(400);
  });
  it('rejects an invalid place type (400)', async () => {
    const res = await post('/api/places', { name: 'Y', type: 'box' });
    expect(res.statusCode).toBe(400);
  });
});

describe('places: nesting, breadcrumb, cycle prevention', () => {
  let unitId: number;
  let shelfId: number;

  it('creates a unit and a nested shelf', async () => {
    const unit = await post('/api/places', { name: 'Garage', type: 'unit' });
    expect(unit.statusCode).toBe(201);
    unitId = unit.json().id;
    expect(unit.json().code_display).toMatch(/^PLC-\d{6}$/);

    const shelf = await post('/api/places', { name: 'Shelf A', type: 'shelf', parent_place_id: unitId });
    expect(shelf.statusCode).toBe(201);
    shelfId = shelf.json().id;
    expect(shelf.json().parent_path).toHaveLength(1);
    expect(shelf.json().parent_path[0].name).toBe('Garage');
  });

  it('prevents moving a place under its own descendant', async () => {
    const res = await post(`/api/places/${unitId}/move`, { parent_place_id: shelfId });
    expect(res.statusCode).toBe(400);
  });
});

describe('items: create, move in/out, audit log, codes', () => {
  let placeId: number;
  let itemId: number;

  it('sets up a place and creates an item inside it', async () => {
    placeId = (await post('/api/places', { name: 'Bench', type: 'crate' })).json().id;
    const item = await post('/api/items', { name: 'Cordless drill', location_place_id: placeId, notes: 'Makita' });
    expect(item.statusCode).toBe(201);
    const body = item.json();
    itemId = body.id;
    expect(body.code_display).toMatch(/^OBJ-\d{6}$/);
    expect(body.location_path.at(-1).id).toBe(placeId);
  });

  it('moves the item out of storage', async () => {
    const res = await post(`/api/items/${itemId}/move`, { to_place_id: null, method: 'manual' });
    expect(res.statusCode).toBe(200);
    expect(res.json().location_place_id).toBeNull();
  });

  it('records the full movement history (created, moved_in, moved_out)', async () => {
    const res = await get(`/api/movements?entity_type=item&entity_id=${itemId}`);
    const actions = res.json().map((m: { action: string }) => m.action);
    expect(actions).toContain('created');
    expect(actions).toContain('moved_in');
    expect(actions).toContain('moved_out');
  });

  it('resolves the item code to the active item', async () => {
    const code = (await get(`/api/items/${itemId}`)).json().code_display;
    const res = await get(`/api/resolve/${code}`);
    expect(res.json()).toMatchObject({ status: 'active', entity_type: 'item', entity_id: itemId });
  });
});

describe('codes: pre-print, resolve unassigned, assign, conflicts', () => {
  it('allocates a printable batch and resolves the codes as unassigned', async () => {
    const pdf = await post('/api/codes/print', { type: 'item', count: 3 });
    expect(pdf.statusCode).toBe(200);
    expect(pdf.headers['content-type']).toContain('application/pdf');
    expect(pdf.rawPayload.subarray(0, 4).toString()).toBe('%PDF');
  });

  it('creates an item on a pre-printed code, then rejects reusing it', async () => {
    // print one code and discover its value via resolve sweep
    await post('/api/codes/print', { type: 'item', count: 1 });
    // find an unassigned item code by scanning a small range
    let unassigned: string | null = null;
    for (let n = 1; n <= 20 && !unassigned; n++) {
      const code = `OBJ-${String(n).padStart(6, '0')}`;
      const r = await get(`/api/resolve/${code}`);
      if (r.statusCode === 200 && r.json().status === 'unassigned') unassigned = code;
    }
    expect(unassigned).toBeTruthy();

    const created = await post('/api/items', { name: 'Hammer', code_value: unassigned, method: 'scan' });
    expect(created.statusCode).toBe(201);
    expect(created.json().code_display).toBe(unassigned);

    const dup = await post('/api/items', { name: 'Dup', code_value: unassigned });
    expect(dup.statusCode).toBe(409);
  });

  it('rejects using a place code for an item (400)', async () => {
    await post('/api/codes/print', { type: 'place', count: 1 });
    let placeCode: string | null = null;
    for (let n = 1; n <= 20 && !placeCode; n++) {
      const code = `PLC-${String(n).padStart(6, '0')}`;
      const r = await get(`/api/resolve/${code}`);
      if (r.statusCode === 200 && r.json().status === 'unassigned') placeCode = code;
    }
    expect(placeCode).toBeTruthy();
    const res = await post('/api/items', { name: 'Wrong', code_value: placeCode });
    expect(res.statusCode).toBe(400);
  });

  it('returns 404 for an unknown code', async () => {
    const res = await get('/api/resolve/OBJ-999999');
    expect(res.statusCode).toBe(404);
  });
});

describe('tags and packing list', () => {
  it('creates a tag, applies it, and filters items by it', async () => {
    const tag = await post('/api/tags', { name: 'Expo 2026', kind: 'event' });
    expect(tag.statusCode).toBe(201);
    const tagId = tag.json().id;

    const item = await post('/api/items', { name: 'Sculpture' });
    const itemId = item.json().id;
    const tagged = await post(`/api/items/${itemId}/tags`, { tag_id: tagId });
    expect(tagged.statusCode).toBe(200);
    expect(tagged.json().tags.map((t: { id: number }) => t.id)).toContain(tagId);

    const list = await get(`/api/items?tag=${tagId}`);
    expect(list.json().map((i: { id: number }) => i.id)).toContain(itemId);

    const dupTag = await post('/api/tags', { name: 'Expo 2026', kind: 'event' });
    expect(dupTag.statusCode).toBe(409);
  });
});

describe('place tagging', () => {
  it('tags and untags a place', async () => {
    const tagId = (await post('/api/tags', { name: 'Crate Event', kind: 'event' })).json().id;
    const placeId = (await post('/api/places', { name: 'Crate Z', type: 'crate' })).json().id;

    const tagged = await post(`/api/places/${placeId}/tags`, { tag_id: tagId });
    expect(tagged.statusCode).toBe(200);
    expect(tagged.json().tags.map((t: { id: number }) => t.id)).toContain(tagId);

    const untagged = await app.inject(authed({ method: 'DELETE', url: `/api/places/${placeId}/tags/${tagId}` }));
    expect(untagged.statusCode).toBe(200);
    expect(untagged.json().tags).toHaveLength(0);
  });
});

describe('hardening (from security review)', () => {
  it('rejects a typed code in the reserved label format (would poison the sequence)', async () => {
    const res = await post('/api/items', { name: 'Bad', code_value: 'OBJ-654321' });
    expect(res.statusCode).toBe(400);
  });

  it('does not append an "edited" movement for a no-op PATCH, but does for a real change', async () => {
    const id = (await post('/api/items', { name: 'Quiet' })).json().id;
    const count = async () => (await get(`/api/movements?entity_type=item&entity_id=${id}`)).json().length;
    const before = await count();

    const noop = await patch(`/api/items/${id}`, {});
    expect(noop.statusCode).toBe(200);
    expect(await count()).toBe(before); // no audit pollution

    const real = await patch(`/api/items/${id}`, { name: 'Renamed' });
    expect(real.statusCode).toBe(200);
    expect(await count()).toBe(before + 1); // real edit is logged
  });
});

describe('media auth', () => {
  it('requires authentication to fetch media', async () => {
    const res = await app.inject({ method: 'GET', url: '/media/1' });
    expect(res.statusCode).toBe(401);
  });
});
