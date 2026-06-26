import { useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { QrScanner } from '../components/Scanner.tsx';
import { PlacePicker } from '../components/PlacePicker.tsx';
import { resolveCode, useBulkMove } from '../lib/queries.ts';
import { api } from '../lib/api.ts';

type Dest = { id: number; name: string } | 'OUT' | null;

/**
 * The home screen is a scan-driven move builder. Scan a place to set the
 * destination and scan objects to add them (in any order) — nothing moves until
 * CONFIRM. Scanning a blank (unassigned) label jumps to registering it.
 */
export function ScanPage() {
  const nav = useNavigate();
  const bulkMove = useBulkMove();
  const [dest, setDest] = useState<Dest>(null);
  const [objs, setObjs] = useState<{ id: number; name: string }[]>([]);
  const [picking, setPicking] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const lastScan = useRef<{ code: string; at: number }>({ code: '', at: 0 });

  async function onCode(raw: string) {
    const c = raw.trim().toUpperCase();
    if (!c) return;
    const now = Date.now();
    // Debounce: ignore the same code re-decoded within 2s (camera streams it repeatedly).
    if (lastScan.current.code === c && now - lastScan.current.at < 2000) return;
    lastScan.current = { code: c, at: now };

    const r = await resolveCode(c);
    if (!r) {
      setMsg(`Unknown code ${c}`);
      return;
    }
    if (r.status === 'unassigned') {
      // A blank pre-printed label → go register it (object or place per the label type).
      nav(`/${r.entity_type === 'item' ? 'items' : 'places'}/new?code=${encodeURIComponent(c)}`);
      return;
    }
    if (r.status !== 'active' || r.entity_id == null) {
      setMsg(`${c} is not usable (${r.status}).`);
      return;
    }
    setMsg(null);
    if (r.entity_type === 'place') {
      const p = await api.get<{ id: number; name: string }>(`/api/places/${r.entity_id}`);
      setDest({ id: p.id, name: p.name });
    } else {
      const it = await api.get<{ id: number; name: string }>(`/api/items/${r.entity_id}`);
      setObjs((prev) => (prev.some((o) => o.id === it.id) ? prev : [...prev, { id: it.id, name: it.name }]));
    }
  }

  async function pickPlace(id: number) {
    const p = await api.get<{ id: number; name: string }>(`/api/places/${id}`);
    setDest({ id: p.id, name: p.name });
  }

  function reset() {
    setDest(null);
    setObjs([]);
    setMsg(null);
  }

  const destLabel = dest === 'OUT' ? 'out of storage' : dest ? dest.name : null;
  const empty = objs.length === 0 && dest === null;
  const canConfirm = objs.length > 0 && dest !== null && !bulkMove.isPending;

  async function confirm() {
    if (objs.length === 0 || dest === null) return;
    const toPlaceId = dest === 'OUT' ? null : dest.id;
    const res = await bulkMove.mutateAsync({ item_ids: objs.map((o) => o.id), to_place_id: toPlaceId, method: 'scan' });
    setMsg(`✓ Moved ${res.moved} object${res.moved === 1 ? '' : 's'} ${dest === 'OUT' ? 'out' : 'to ' + destLabel}.`);
    setDest(null);
    setObjs([]);
  }

  return (
    <div className="col">
      <QrScanner onCode={(c) => void onCode(c)} paused={picking} />

      <div className="row">
        <button className="btn grow" onClick={() => setPicking(true)}>
          📍 Pick place
        </button>
        <button
          className={`btn grow ${dest === 'OUT' ? 'primary' : ''}`}
          onClick={() => setDest((d) => (d === 'OUT' ? null : 'OUT'))}
        >
          📤 Take out
        </button>
      </div>

      <div className="preview-box">
        {empty ? (
          <span className="muted">Scan an object or a place to begin. Scan a blank label to register it.</span>
        ) : (
          <>
            <div>
              <b>{objs.length}</b> object{objs.length === 1 ? '' : 's'}{' '}
              {destLabel ? (
                <>
                  → <b className="ok">{destLabel}</b>
                </>
              ) : (
                <span className="warn">→ scan or pick a destination</span>
              )}
            </div>
            {objs.length > 0 && (
              <div className="small muted" style={{ marginTop: 4 }}>
                {objs.map((o) => o.name).join(', ')}
              </div>
            )}
          </>
        )}
        {msg && (
          <div className="small" style={{ marginTop: 6 }}>
            {msg}
          </div>
        )}
      </div>

      <div className="row" style={{ gap: 12 }}>
        <button className="bigbtn confirm" disabled={!canConfirm} onClick={() => void confirm()}>
          CONFIRM
        </button>
        <button className="bigbtn cancel" disabled={empty} onClick={reset}>
          CANCEL
        </button>
      </div>

      {picking && (
        <PlacePicker
          title="Destination place"
          onPick={(id) => {
            setPicking(false);
            if (id != null) void pickPlace(id);
          }}
          onClose={() => setPicking(false)}
        />
      )}
    </div>
  );
}
