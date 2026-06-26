import type { Config } from '../config.js';

// M7 — Google Sheet mirror. DEFERRED: needs a Google Cloud project + service
// account, which the owner will set up later. This stub keeps the wiring and
// the API endpoints present so M7 can be filled in without restructuring.
// When implemented, export DB tables -> Sheet tabs (debounced + periodic
// reconcile) using `googleapis` with a service account. See SPEC §5.8.

export interface SheetMirror {
  readonly configured: boolean;
  status(): { configured: boolean; sheetId: string | null; message: string };
  exportNow(): Promise<void>;
  scheduleSync(): void;
}

export function createSheetMirror(config: Config): SheetMirror {
  const configured = Boolean(config.sheetId && config.googleServiceAccountJson);
  return {
    configured,
    status() {
      return {
        configured,
        sheetId: config.sheetId,
        message: configured
          ? 'Sheet mirror configured (export not yet implemented — M7).'
          : 'Sheet mirror not configured. Set SHEET_ID and GOOGLE_SERVICE_ACCOUNT_JSON (M7, deferred).',
      };
    },
    async exportNow() {
      throw new Error('Sheet mirror not implemented yet (M7 deferred).');
    },
    scheduleSync() {
      /* no-op until M7 */
    },
  };
}
