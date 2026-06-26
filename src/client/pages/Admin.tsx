import { useState, type ChangeEvent } from 'react';
import { Link } from 'react-router-dom';
import { useImportXlsx, useSheetStatus, useSyncSheet } from '../lib/queries.ts';
import { ErrorMsg } from '../components/ui.tsx';
import type { ImportSummary } from '../lib/api.ts';

const XLSX_ACCEPT = '.xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

export function AdminPage() {
  const importMut = useImportXlsx();
  const sheet = useSheetStatus();
  const syncSheet = useSyncSheet();
  const [summary, setSummary] = useState<ImportSummary | null>(null);

  async function onFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setSummary(null);
    setSummary(await importMut.mutateAsync(file));
  }

  return (
    <div className="col">
      <h2 style={{ margin: 0 }}>Admin</h2>

      <div className="card">
        <b>Data (Excel)</b>
        <p className="small muted">
          Export the whole stock to a spreadsheet, edit it, and import it back. Same template — rows are matched by
          their QR code.
        </p>
        <div className="row">
          <a className="btn primary grow" href="/api/export.xlsx">
            ⬇ Export .xlsx
          </a>
          <label className="btn grow" style={{ margin: 0 }}>
            {importMut.isPending ? 'Importing…' : '⬆ Import .xlsx'}
            <input type="file" accept={XLSX_ACCEPT} style={{ display: 'none' }} onChange={onFile} disabled={importMut.isPending} />
          </label>
        </div>
        <ErrorMsg error={importMut.error} />
        {summary && (
          <div className="notice small" style={{ marginTop: 10 }}>
            Imported — places: {summary.placesCreated} new / {summary.placesUpdated} updated · objects:{' '}
            {summary.itemsCreated} new / {summary.itemsUpdated} updated · tags: {summary.tagsCreated} new.
            {summary.errors.length > 0 && (
              <div className="error" style={{ marginTop: 6 }}>
                {summary.errors.length} row(s) skipped: {summary.errors.slice(0, 5).join('; ')}
              </div>
            )}
          </div>
        )}
      </div>

      <div className="card">
        <b>Google Sheet (read-only mirror)</b>
        {sheet.data && !sheet.data.configured ? (
          <p className="small muted">
            Not configured. Set <code>SHEET_ID</code> and <code>GOOGLE_SERVICE_ACCOUNT_JSON</code> on the server (see
            the setup steps), then collaborators can consult a live, read-only copy of places, items and tags.
          </p>
        ) : (
          <>
            <p className="small muted">
              Live one-way mirror of places, items and tags.{' '}
              {sheet.data?.url && (
                <a href={sheet.data.url} target="_blank" rel="noreferrer">
                  Open the sheet ↗
                </a>
              )}
            </p>
            <button
              className="btn primary block"
              onClick={() => syncSheet.mutate()}
              disabled={syncSheet.isPending || sheet.data?.syncing}
            >
              {syncSheet.isPending || sheet.data?.syncing ? 'Syncing…' : 'Sync now'}
            </button>
            <div className="small muted" style={{ marginTop: 8 }}>
              {sheet.data?.lastSync ? `Last synced: ${new Date(sheet.data.lastSync).toLocaleString()}` : 'Not synced yet.'}
            </div>
            <ErrorMsg error={syncSheet.error} />
            {sheet.data?.lastError && <p className="error small">Last sync error: {sheet.data.lastError}</p>}
          </>
        )}
      </div>

      <Link className="list-item" to="/archive">
        <span className="thumb">🗃️</span>
        <span className="grow">
          <b>Archive</b>
          <div className="small muted">Restore or permanently delete archived objects &amp; places</div>
        </span>
        <span className="right small muted">›</span>
      </Link>
      <Link className="list-item" to="/users">
        <span className="thumb">👥</span>
        <span className="grow">
          <b>Users</b>
          <div className="small muted">Add or remove users, reset passwords</div>
        </span>
        <span className="right small muted">›</span>
      </Link>
    </div>
  );
}
