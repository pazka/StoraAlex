// Google Sheet mirror (lib/sheet.ts). No outbound network: @googleapis/sheets is
// mocked for the configured-path tests; the real module is only imported to
// check its export shape. Guards @googleapis/sheets upgrades and the
// "sheet failures never break the app" guarantee.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { makeApp, loginCookie } from './helpers.ts';

const google = vi.hoisted(() => ({
  log: [] as [string, unknown][],
  fail: null as unknown,
  existingTabs: ['Sheet1'] as string[],
}));

vi.mock('@googleapis/sheets', () => {
  const op = (name: string) => async (args: unknown) => {
    google.log.push([name, args]);
    if (google.fail) throw google.fail;
    if (name === 'get') return { data: { sheets: google.existingTabs.map((title) => ({ properties: { title } })) } };
    return { data: {} };
  };
  return {
    auth: {
      GoogleAuth: class {
        constructor(opts: unknown) {
          google.log.push(['GoogleAuth', opts]);
        }
      },
    },
    sheets: (opts: unknown) => {
      google.log.push(['sheets', opts]);
      return {
        spreadsheets: {
          get: op('get'),
          batchUpdate: op('batchUpdate'),
          values: { batchClear: op('batchClear'), batchUpdate: op('values.batchUpdate') },
        },
      };
    },
  };
});

// Fake service-account credentials (never sent anywhere: the client is mocked).
const FAKE_SA = { type: 'service_account', client_email: 'mirror@fake-project.iam.gserviceaccount.com', private_key: 'fake' };

beforeEach(() => {
  google.log.length = 0;
  google.fail = null;
  google.existingTabs = ['Sheet1'];
});

describe('not configured (no SHEET_ID) — the default deployment', () => {
  it('boots, reports not configured, and 501s a manual export', async () => {
    const { app } = await makeApp();
    const cookie = await loginCookie(app);
    const status = await app.inject({ method: 'GET', url: '/api/sheet/status', headers: { cookie } });
    expect(status.json()).toEqual({ configured: false, sheetId: null, url: null, lastSync: null, lastError: null, syncing: false });
    const exp = await app.inject({ method: 'POST', url: '/api/sheet/export', headers: { cookie } });
    expect(exp.statusCode).toBe(501);
    expect(exp.json()).toEqual({ error: 'Google Sheet not configured — set SHEET_ID and GOOGLE_SERVICE_ACCOUNT_JSON' });
    await app.close();
  });

  it('SHEET_ID without credentials is still "not configured"', async () => {
    const { app } = await makeApp({ env: { SHEET_ID: 'fake-sheet-id' } });
    expect(app.sheetMirror.configured).toBe(false);
    expect(app.sheetMirror.status()).toMatchObject({ configured: false, sheetId: 'fake-sheet-id' });
    await app.close();
  });

  it('mutations never schedule or touch Google, and nothing throws', async () => {
    const { app } = await makeApp();
    const cookie = await loginCookie(app);
    const spy = vi.spyOn(app.sheetMirror, 'scheduleSync');
    const res = await app.inject({ method: 'POST', url: '/api/items', payload: { name: 'x' }, headers: { cookie } });
    expect(res.statusCode).toBe(201);
    await new Promise((r) => setTimeout(r, 20)); // onResponse runs after inject() resolves
    expect(spy).not.toHaveBeenCalled();
    expect(() => app.sheetMirror.scheduleSync()).not.toThrow();
    await expect(app.sheetMirror.exportNow()).rejects.toThrow(/not configured/);
    expect(google.log).toEqual([]);
    await app.close();
  });
});

describe('configured (mocked Google client)', () => {
  const env = { SHEET_ID: 'fake-sheet-id', GOOGLE_SERVICE_ACCOUNT_JSON: JSON.stringify(FAKE_SA), SHEET_SYNC_DEBOUNCE_MS: '5' };
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await close?.();
    close = undefined;
  });

  async function setup(extra: NodeJS.ProcessEnv = {}) {
    const m = await makeApp({ env: { ...env, ...extra } });
    close = () => m.app.close();
    return { ...m, cookie: await loginCookie(m.app) };
  }

  it('debounces a push after a successful mutation, with the pinned tab layout', async () => {
    const { app, cookie } = await setup();
    const post = (url: string, payload: unknown) => app.inject({ method: 'POST', url, payload, headers: { cookie } });
    const place = (await post('/api/places', { name: 'Garage' })).json();
    await post('/api/tags', { name: 'Expo', kind: 'event', color: '#f00' });
    await post('/api/items', { name: 'Drill', location_place_id: place.id, price: 10, notes: 'n' });

    await vi.waitFor(() => expect(app.sheetMirror.status().lastSync).not.toBeNull());
    const names = google.log.map(([n]) => n);
    expect(names).toEqual(['GoogleAuth', 'sheets', 'get', 'batchUpdate', 'batchClear', 'values.batchUpdate']);

    expect(google.log[0]![1]).toEqual({ credentials: FAKE_SA, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
    expect(google.log[1]![1]).toMatchObject({ version: 'v4' });
    expect(google.log[3]![1]).toEqual({
      spreadsheetId: 'fake-sheet-id',
      requestBody: {
        requests: ['Places', 'Items', 'Tags'].map((title) => ({ addSheet: { properties: { title } } })),
      },
    });
    expect(google.log[4]![1]).toEqual({
      spreadsheetId: 'fake-sheet-id',
      requestBody: { ranges: ['Places!A1:Z100000', 'Items!A1:Z100000', 'Tags!A1:Z100000'] },
    });
    expect(google.log[5]![1]).toEqual({
      spreadsheetId: 'fake-sheet-id',
      requestBody: {
        valueInputOption: 'RAW',
        data: [
          { range: 'Places!A1', values: [['Code', 'Name', 'Inside (path)', 'Info'], [place.code_display, 'Garage', '', '']] },
          {
            range: 'Items!A1',
            values: [
              ['Code', 'Name', 'Location', 'In/Out', 'Price', 'Tags', 'Notes'],
              ['OBJ-000001', 'Drill', 'Garage', 'in', 10, '', 'n'],
            ],
          },
          { range: 'Tags!A1', values: [['Name', 'Kind', 'Color'], ['Expo', 'event', '#f00']] },
        ],
      },
    });
    expect(app.sheetMirror.status()).toMatchObject({
      configured: true,
      url: 'https://docs.google.com/spreadsheets/d/fake-sheet-id/edit',
      lastError: null,
      syncing: false,
    });
  });

  it('only schedules after successful non-GET inventory requests', async () => {
    const { app, cookie } = await setup({ SHEET_SYNC_DEBOUNCE_MS: '60000' });
    const spy = vi.spyOn(app.sheetMirror, 'scheduleSync');
    const req = (method: 'GET' | 'POST', url: string, payload?: unknown) =>
      app.inject({ method, url, payload: payload as object, headers: { cookie } });
    await req('GET', '/api/items');
    await req('POST', '/api/items', { name: '' }); // 400
    await req('POST', '/api/auth/login', { username: 'tester', password: 'pw-12345678' }); // /api/auth is skipped
    await req('POST', '/api/sheet/export'); // /api/sheet is skipped
    // onResponse runs after inject() resolves: wait for the one qualifying call,
    // then the exact count proves none of the requests above scheduled.
    await req('POST', '/api/tags', { name: 'ok' });
    await vi.waitFor(() => expect(spy).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 20));
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('a failing Google API never breaks the request; the error is reported in status', async () => {
    google.fail = Object.assign(new Error('forbidden'), { code: 403 });
    const { app, cookie } = await setup();
    const res = await app.inject({ method: 'POST', url: '/api/items', payload: { name: 'still works' }, headers: { cookie } });
    expect(res.statusCode).toBe(201);
    await vi.waitFor(() => expect(app.sheetMirror.status().lastError).not.toBeNull());
    expect(app.sheetMirror.status().lastError).toMatch(
      /^Google denied access \(403\) — share the Sheet with the service account \(mirror@fake-project\.iam\.gserviceaccount\.com\) as Editor/,
    );
    expect(app.sheetMirror.status().lastSync).toBeNull();

    const manual = await app.inject({ method: 'POST', url: '/api/sheet/export', headers: { cookie } });
    expect(manual.statusCode).toBe(502);
    expect(manual.json().error).toMatch(/^sync failed: Google denied access \(403\)/);
    // The app is still healthy.
    expect((await app.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(200);
  });

  it('maps 404 / 401 to actionable messages', async () => {
    const { app } = await setup();
    google.fail = Object.assign(new Error('nf'), { code: 404 });
    await expect(app.sheetMirror.exportNow()).rejects.toThrow(/^Sheet not found \(404\) — check SHEET_ID/);
    google.fail = Object.assign(new Error('bad key'), { response: { status: 401 }, status: 401 });
    await expect(app.sheetMirror.exportNow()).rejects.toThrow(/^Authentication failed \(401\)/);
  });

  it('reads credentials from a file path, and a malformed key fails softly', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'storalex-sa-'));
    const good = path.join(dir, 'fake-key.json');
    fs.writeFileSync(good, JSON.stringify(FAKE_SA));
    const a = await setup({ GOOGLE_SERVICE_ACCOUNT_JSON: good });
    await a.app.sheetMirror.exportNow();
    expect(google.log[0]).toEqual(['GoogleAuth', { credentials: FAKE_SA, scopes: ['https://www.googleapis.com/auth/spreadsheets'] }]);
    await close!();

    const bad = path.join(dir, 'broken-key.json');
    fs.writeFileSync(bad, '{not json');
    const b = await setup({ GOOGLE_SERVICE_ACCOUNT_JSON: bad });
    const res = await b.app.inject({ method: 'POST', url: '/api/tags', payload: { name: 't' }, headers: { cookie: b.cookie } });
    expect(res.statusCode).toBe(201);
    await vi.waitFor(() => expect(b.app.sheetMirror.status().lastError).toMatch(/JSON/));
  });
});

describe('@googleapis/sheets real export shape (no network)', () => {
  it('exposes sheets() and auth.GoogleAuth the way lib/sheet.ts uses them', async () => {
    const real = await vi.importActual<typeof import('@googleapis/sheets')>('@googleapis/sheets');
    expect(typeof real.sheets).toBe('function');
    expect(typeof real.auth.GoogleAuth).toBe('function');
    const auth = new real.auth.GoogleAuth({ credentials: FAKE_SA, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
    const client = real.sheets({ version: 'v4', auth });
    expect(typeof client.spreadsheets.get).toBe('function');
    expect(typeof client.spreadsheets.batchUpdate).toBe('function');
    expect(typeof client.spreadsheets.values.batchClear).toBe('function');
    expect(typeof client.spreadsheets.values.batchUpdate).toBe('function');
  });
});
