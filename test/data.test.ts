import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance, InjectOptions } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import { makeApp, loginCookie } from './helpers.ts';
import { createRepos } from '../src/server/db/repos.ts';
import { tx } from '../src/server/db/index.ts';
import { buildWorkbook, readWorkbook } from '../src/server/lib/excel.ts';
import { importData } from '../src/server/routes/data.ts';

let app: FastifyInstance;
let db: DatabaseSync;
let cookie: string;

beforeAll(async () => {
  const m = await makeApp();
  app = m.app;
  db = m.db;
  cookie = await loginCookie(app);
});
afterAll(async () => {
  await app.close();
});

const authed = (o: InjectOptions): InjectOptions => ({ ...o, headers: { ...(o.headers ?? {}), cookie } });
const post = (url: string, payload?: unknown) => app.inject(authed({ method: 'POST', url, payload }));
const del = (url: string) => app.inject(authed({ method: 'DELETE', url }));
const get = (url: string) => app.inject(authed({ method: 'GET', url }));

describe('archive + permanent delete', () => {
  it('archives an item (hidden from default list, shown in archived), then restores', async () => {
    const id = (await post('/api/items', { name: 'Archivable' })).json().id;
    expect((await post(`/api/items/${id}/archive`)).statusCode).toBe(200);

    const visible = (await get('/api/items')).json().map((i: { id: number }) => i.id);
    expect(visible).not.toContain(id);
    const archived = (await get('/api/items?archived=true')).json().map((i: { id: number }) => i.id);
    expect(archived).toContain(id);

    await post(`/api/items/${id}/unarchive`);
    expect((await get('/api/items')).json().map((i: { id: number }) => i.id)).toContain(id);
  });

  it('refuses to permanently delete a non-archived item, allows it once archived', async () => {
    const id = (await post('/api/items', { name: 'DeleteMe' })).json().id;
    expect((await del(`/api/items/${id}`)).statusCode).toBe(400);
    await post(`/api/items/${id}/archive`);
    expect((await del(`/api/items/${id}`)).statusCode).toBe(200);
    expect((await get(`/api/items/${id}`)).statusCode).toBe(404);
  });

  it('cascade-deletes an archived place subtree (nested places + their items)', async () => {
    const root = (await post('/api/places', { name: 'Unit' })).json().id;
    const child = (await post('/api/places', { name: 'Crate', parent_place_id: root })).json().id;
    const itemId = (await post('/api/items', { name: 'Inside', location_place_id: child })).json().id;

    expect((await del(`/api/places/${root}`)).statusCode).toBe(400); // not archived
    await post(`/api/places/${root}/archive`);
    const res = await del(`/api/places/${root}`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ placesDeleted: 2, itemsDeleted: 1 });
    expect((await get(`/api/places/${child}`)).statusCode).toBe(404);
    expect((await get(`/api/items/${itemId}`)).statusCode).toBe(404);
  });
});

describe('excel export / import round-trip', () => {
  it('exports a valid workbook and re-imports edits keyed by code', async () => {
    const place = (await post('/api/places', { name: 'Shed' })).json();
    const item = (await post('/api/items', { name: 'Spade', location_place_id: place.id })).json();

    // export through the route -> valid xlsx
    const exp = await get('/api/export.xlsx');
    expect(exp.statusCode).toBe(200);
    expect(exp.rawPayload.subarray(0, 2).toString()).toBe('PK');

    // parse, edit the item's name, re-import
    const parsed = await readWorkbook(exp.rawPayload);
    const row = parsed.items.find((r) => r.code === item.code_display);
    expect(row).toBeTruthy();
    row!.name = 'Garden spade';
    row!.price = '42';

    const repos = createRepos(db);
    const summary = tx(db, () => importData(repos, parsed));
    expect(summary.itemsUpdated).toBeGreaterThan(0);

    const after = (await get(`/api/items/${item.id}`)).json();
    expect(after.name).toBe('Garden spade');
    expect(after.price).toBe(42);
  });

  it('reports the Google Sheet mirror as not configured (no creds in tests)', async () => {
    expect((await get('/api/sheet/status')).json().configured).toBe(false);
    expect((await post('/api/sheet/export')).statusCode).toBe(501);
  });

  it('buildWorkbook + readWorkbook preserve rows', async () => {
    const buf = await buildWorkbook({
      places: [{ code: 'PLC-000999', name: 'Test', parent_code: '', info: '', archived: 'no' }],
      items: [{ code: 'OBJ-000999', name: 'Thing', place_code: 'PLC-000999', price: 5, notes: '', tags: 'x', archived: 'no' }],
      tags: [{ name: 'x', color: null, kind: 'flag' }],
    });
    const back = await readWorkbook(buf);
    expect(back.places[0].name).toBe('Test');
    expect(back.items[0].name).toBe('Thing');
    expect(back.items[0].place_code).toBe('PLC-000999');
  });
});
