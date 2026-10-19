// Request validation (SPEC §7.4): TypeBox schemas with additionalProperties:false
// plus ajv removeAdditional:false => unknown fields are REJECTED, not stripped.
// Guards fastify / ajv / @sinclair/typebox / type-provider upgrades, which could
// flip defaults (strip instead of reject, coercion rules, error shape).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { makeApp, loginCookie, TEST_USER, TEST_PW } from './helpers.ts';

let app: FastifyInstance;
let cookie: string;
let itemId: number;
let placeId: number;
let tagId: number;
let userId: number;

beforeAll(async () => {
  ({ app } = await makeApp());
  cookie = await loginCookie(app);
  placeId = (await send({ method: 'POST', url: '/api/places', payload: { name: 'P' } })).json().id;
  itemId = (await send({ method: 'POST', url: '/api/items', payload: { name: 'I' } })).json().id;
  tagId = (await send({ method: 'POST', url: '/api/tags', payload: { name: 'T' } })).json().id;
  userId = (await send({ method: 'GET', url: '/api/me' })).json().user.id;
});
afterAll(async () => {
  await app.close();
});

function send(opts: InjectOptions) {
  return app.inject({ ...opts, headers: { ...(opts.headers ?? {}), cookie } });
}

const counts = async () => ({
  items: (await send({ method: 'GET', url: '/api/items' })).json().length,
  places: (await send({ method: 'GET', url: '/api/places' })).json().length,
  tags: (await send({ method: 'GET', url: '/api/tags' })).json().length,
});

// Each body is VALID on its own; adding `bogus` must turn it into a 400.
const BODY_CASES: [string, string, () => Record<string, unknown>][] = [
  ['POST', '/api/auth/login', () => ({ username: TEST_USER, password: TEST_PW })],
  ['POST', '/api/auth/setup', () => ({ username: 'someone', password: 'longenough1' })],
  ['POST', '/api/users', () => ({ username: 'newuser', password: 'longenough1' })],
  ['POST', '/api/users/:user/password', () => ({ password: 'longenough1' })],
  ['POST', '/api/items', () => ({ name: 'x' })],
  ['PATCH', '/api/items/:item', () => ({ name: 'x' })],
  ['POST', '/api/items/:item/move', () => ({ to_place_id: null })],
  ['POST', '/api/items/bulk-move', () => ({ item_ids: [itemId], to_place_id: null })],
  ['POST', '/api/items/:item/tags', () => ({ tag_id: tagId })],
  ['POST', '/api/places', () => ({ name: 'x' })],
  ['PATCH', '/api/places/:place', () => ({ name: 'x' })],
  ['POST', '/api/places/:place/move', () => ({ parent_place_id: null })],
  ['POST', '/api/places/:place/tags', () => ({ tag_id: tagId })],
  ['POST', '/api/codes/print', () => ({ type: 'item', count: 1 })],
  ['POST', '/api/codes/assign', () => ({ code_value: 'CUSTOM-1', entity_type: 'item', entity_id: itemId })],
  ['POST', '/api/tags', () => ({ name: 'x' })],
];
const fill = (url: string) =>
  url.replace(':user', String(userId)).replace(':item', String(itemId)).replace(':place', String(placeId));

describe('unknown body fields are rejected (400), never stripped', () => {
  it.each(BODY_CASES)('%s %s', async (method, url, body) => {
    const before = await counts();
    const res = await send({ method: method as InjectOptions['method'], url: fill(url), payload: { ...body(), bogus: 1 } });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({
      statusCode: 400,
      code: 'FST_ERR_VALIDATION',
      error: 'Bad Request',
      message: 'body must NOT have additional properties',
    });
    expect(await counts()).toEqual(before); // no side effect
  });
});

describe('unknown query fields are rejected (400)', () => {
  it.each(['/api/items', '/api/places', '/api/movements'])('GET %s?bogus=1', async (url) => {
    const res = await send({ method: 'GET', url: `${url}?bogus=1` });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'FST_ERR_VALIDATION', message: 'querystring must NOT have additional properties' });
  });
});

describe('type rules', () => {
  it('rejects ids outside 1..2^31-1 and non-integer ids', async () => {
    for (const id of ['0', '2147483648', '1.5', 'abc', '-1']) {
      const res = await send({ method: 'GET', url: `/api/items/${id}` });
      expect(res.statusCode, id).toBe(400);
    }
    expect((await send({ method: 'GET', url: '/api/items/2147483647' })).statusCode).toBe(404);
  });

  it('rejects a code value outside [A-Za-z0-9-] (and over 64 chars)', async () => {
    expect((await send({ method: 'GET', url: '/api/resolve/bad_code' })).statusCode).toBe(400);
    expect((await send({ method: 'GET', url: `/api/resolve/${'A'.repeat(65)}` })).statusCode).toBe(400);
  });

  it('enforces string length bounds (name 1..200)', async () => {
    expect((await send({ method: 'POST', url: '/api/items', payload: { name: '' } })).statusCode).toBe(400);
    expect((await send({ method: 'POST', url: '/api/items', payload: { name: 'n'.repeat(201) } })).statusCode).toBe(400);
    expect((await send({ method: 'POST', url: '/api/items', payload: { name: 'n'.repeat(200) } })).statusCode).toBe(201);
  });

  it('rejects enum values outside the literal union', async () => {
    const res = await send({ method: 'POST', url: '/api/tags', payload: { name: 'k', kind: 'nope' } });
    expect(res.statusCode).toBe(400);
  });

  it('coerces scalar strings (coerceTypes) — "12.5" price becomes 12.5', async () => {
    const res = await send({ method: 'POST', url: '/api/items', payload: { name: 'coerced', price: '12.5' } });
    expect(res.statusCode).toBe(201);
    expect(res.json().price).toBe(12.5);
  });

  it('keeps an explicit null as null (Null-first unions), not 0', async () => {
    const id = (await send({ method: 'POST', url: '/api/items', payload: { name: 'nullable', price: 7 } })).json().id;
    const res = await send({ method: 'PATCH', url: `/api/items/${id}`, payload: { price: null } });
    expect(res.statusCode).toBe(200);
    expect(res.json().price).toBeNull();
  });

  it('coerces boolean query strings and rejects non-integer query ids', async () => {
    expect((await send({ method: 'GET', url: '/api/items?archived=true' })).statusCode).toBe(200);
    const bad = await send({ method: 'GET', url: '/api/items?tag=abc' });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().message).toBe('querystring/tag must be integer');
  });

  it('wraps a single value into an array (coerceTypes: "array")', async () => {
    const res = await send({ method: 'POST', url: '/api/items/bulk-move', payload: { item_ids: itemId, to_place_id: placeId } });
    expect(res.statusCode).toBe(200);
    expect(res.json().moved).toBe(1);
  });
});

describe('body parsing', () => {
  it('rejects malformed JSON with FST_ERR_CTP_INVALID_JSON_BODY', async () => {
    const res = await send({
      method: 'POST',
      url: '/api/tags',
      payload: '{bad',
      headers: { 'content-type': 'application/json' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'FST_ERR_CTP_INVALID_JSON_BODY' });
  });

  it('rejects a JSON body over the 1 MiB limit with 413', async () => {
    const res = await send({ method: 'POST', url: '/api/items', payload: { name: 'x', notes: 'n'.repeat(1024 * 1024) } });
    expect(res.statusCode).toBe(413);
    expect(res.json()).toMatchObject({ code: 'FST_ERR_CTP_BODY_TOO_LARGE' });
  });

  it('parses text/plain (Fastify default parser) and then fails schema validation', async () => {
    const res = await send({ method: 'POST', url: '/api/tags', payload: 'name=x', headers: { 'content-type': 'text/plain' } });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'FST_ERR_VALIDATION', message: 'body must be object' });
  });

  it('rejects an unregistered content type with 415', async () => {
    const res = await send({ method: 'POST', url: '/api/tags', payload: '<x/>', headers: { 'content-type': 'application/xml' } });
    expect(res.statusCode).toBe(415);
    expect(res.json()).toMatchObject({ code: 'FST_ERR_CTP_INVALID_MEDIA_TYPE' });
  });
});
