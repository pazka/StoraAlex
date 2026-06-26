import fs from 'node:fs';
import { sheets as sheetsApi, auth as gauth } from '@googleapis/sheets';
import type { sheets_v4 } from '@googleapis/sheets';
import type { Config } from '../config.js';
import type { Repos } from '../db/repos.js';

// M7 — Google Sheet mirror (read-only / one-way). The app pushes the live
// inventory to tabs in the owner's Sheet so collaborators can consult it; the
// Sheet never writes back (SQLite stays the source of truth). See SPEC §5.8 and
// docs/OWNER-NOTES.md for the Google Cloud setup the owner must do.

const SCOPES = ['https://www.googleapis.com/auth/spreadsheets'];
const PLACE_HEADER = ['Code', 'Name', 'Inside (path)', 'Info'];
const ITEM_HEADER = ['Code', 'Name', 'Location', 'In/Out', 'Price', 'Tags', 'Notes'];
const TAG_HEADER = ['Name', 'Kind', 'Color'];

export interface SheetStatus {
  configured: boolean;
  sheetId: string | null;
  url: string | null;
  lastSync: string | null;
  lastError: string | null;
  syncing: boolean;
}

export interface SheetMirror {
  readonly configured: boolean;
  status(): SheetStatus;
  /** Push the full inventory now. Throws if not configured or on a Google error. */
  exportNow(): Promise<void>;
  /** Debounced push after a data change (no-op if not configured). */
  scheduleSync(): void;
}

type Cell = string | number;

function loadCredentials(value: string): Record<string, unknown> {
  const t = value.trim();
  const raw = t.startsWith('{') ? t : fs.readFileSync(t, 'utf8');
  return JSON.parse(raw) as Record<string, unknown>;
}

/** Turn a Google/Gaxios error into one short, actionable line. */
function describeError(err: unknown, email: string | null): string {
  const e = err as {
    code?: number | string;
    status?: number;
    message?: string;
    response?: { data?: { error?: { message?: string } } };
  };
  const code = typeof e.code === 'number' ? e.code : e.status;
  const detail = e.response?.data?.error?.message ?? e.message ?? 'unknown error';
  if (code === 403) {
    return `Google denied access (403) — share the Sheet with the service account${email ? ` (${email})` : ''} as Editor, and make sure the Google Sheets API is enabled for the project. [${detail}]`;
  }
  if (code === 404) return `Sheet not found (404) — check SHEET_ID. [${detail}]`;
  if (code === 401) return `Authentication failed (401) — check the service-account key. [${detail}]`;
  return detail;
}

function buildRows(repos: Repos): { places: Cell[][]; items: Cell[][]; tags: Cell[][] } {
  const places = repos.places.list({});
  const byId = new Map(places.map((p) => [p.id, p]));
  const pathOf = (id: number | null): string => {
    const parts: string[] = [];
    let cur = id != null ? byId.get(id) : undefined;
    let guard = 0;
    while (cur && guard++ < 60) {
      parts.unshift(cur.name);
      cur = cur.parent_place_id != null ? byId.get(cur.parent_place_id) : undefined;
    }
    return parts.join(' › ');
  };

  const placeRows: Cell[][] = places.map((p) => [
    p.code_display,
    p.name,
    p.parent_place_id != null ? pathOf(p.parent_place_id) : '',
    p.info ?? '',
  ]);
  const itemRows: Cell[][] = repos.items.list({}).map((i) => [
    i.code_display,
    i.name,
    i.location_place_id != null ? pathOf(i.location_place_id) : '',
    i.location_place_id != null ? 'in' : 'out',
    i.price ?? '',
    repos.items.tags(i.id).map((t) => t.name).join(', '),
    i.notes ?? '',
  ]);
  const tagRows: Cell[][] = repos.tags.list().map((t) => [t.name, t.kind, t.color ?? '']);
  return { places: placeRows, items: itemRows, tags: tagRows };
}

async function push(
  client: sheets_v4.Sheets,
  spreadsheetId: string,
  data: { places: Cell[][]; items: Cell[][]; tags: Cell[][] },
): Promise<void> {
  const tabs = [
    { name: 'Places', header: PLACE_HEADER, rows: data.places },
    { name: 'Items', header: ITEM_HEADER, rows: data.items },
    { name: 'Tags', header: TAG_HEADER, rows: data.tags },
  ];

  const meta = await client.spreadsheets.get({ spreadsheetId, fields: 'sheets.properties.title' });
  const existing = new Set((meta.data.sheets ?? []).map((s) => s.properties?.title));
  const addRequests = tabs
    .filter((t) => !existing.has(t.name))
    .map((t) => ({ addSheet: { properties: { title: t.name } } }));
  if (addRequests.length) {
    await client.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests: addRequests } });
  }

  await client.spreadsheets.values.batchClear({
    spreadsheetId,
    requestBody: { ranges: tabs.map((t) => `${t.name}!A1:Z100000`) },
  });
  await client.spreadsheets.values.batchUpdate({
    spreadsheetId,
    requestBody: {
      valueInputOption: 'RAW',
      data: tabs.map((t) => ({ range: `${t.name}!A1`, values: [t.header, ...t.rows] })),
    },
  });
}

export function createSheetMirror(config: Config, repos: Repos): SheetMirror {
  const configured = Boolean(config.sheetId && config.googleServiceAccountJson);
  let client: sheets_v4.Sheets | null = null;
  let serviceAccountEmail: string | null = null;
  let lastSync: string | null = null;
  let lastError: string | null = null;
  let inFlight = false;
  let needsResync = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  function getClient(): sheets_v4.Sheets {
    if (!client) {
      const credentials = loadCredentials(config.googleServiceAccountJson!);
      serviceAccountEmail = typeof credentials.client_email === 'string' ? credentials.client_email : null;
      const authClient = new gauth.GoogleAuth({ credentials, scopes: SCOPES });
      client = sheetsApi({ version: 'v4', auth: authClient });
    }
    return client;
  }

  async function exportNow(): Promise<void> {
    if (!configured) throw new Error('Sheet mirror not configured (set SHEET_ID and GOOGLE_SERVICE_ACCOUNT_JSON)');
    if (inFlight) {
      needsResync = true; // a sync is running; it will pick up the latest data
      return;
    }
    inFlight = true;
    try {
      do {
        needsResync = false;
        await push(getClient(), config.sheetId!, buildRows(repos));
        lastSync = new Date().toISOString();
        lastError = null;
      } while (needsResync);
    } catch (err) {
      lastError = describeError(err, serviceAccountEmail);
      throw new Error(lastError); // clean, actionable message (no giant Gaxios dump)
    } finally {
      inFlight = false;
    }
  }

  function scheduleSync(): void {
    if (!configured) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void exportNow().catch(() => {}), config.sheetSyncDebounceMs);
    timer.unref?.();
  }

  return {
    configured,
    status: () => ({
      configured,
      sheetId: config.sheetId,
      url: config.sheetId ? `https://docs.google.com/spreadsheets/d/${config.sheetId}/edit` : null,
      lastSync,
      lastError,
      syncing: inFlight,
    }),
    exportNow,
    scheduleSync,
  };
}
