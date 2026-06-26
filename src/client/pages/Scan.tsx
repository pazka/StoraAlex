import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { QrScanner } from '../components/Scanner.tsx';
import { resolveCode } from '../lib/queries.ts';
import type { ResolveResult } from '../../shared/types.ts';

export function ScanPage() {
  const nav = useNavigate();
  const [manual, setManual] = useState('');
  const [paused, setPaused] = useState(false);
  const [pending, setPending] = useState<{ code: string; result: ResolveResult | null } | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleCode(code: string) {
    const c = code.trim().toUpperCase();
    if (!c || busy || pending) return;
    setBusy(true);
    setPaused(true);
    const result = await resolveCode(c);
    if (result && result.status === 'active' && result.entity_id) {
      nav(result.entity_type === 'item' ? `/items/${result.entity_id}` : `/places/${result.entity_id}`);
      return;
    }
    setPending({ code: c, result });
    setBusy(false);
  }

  function reset() {
    setPending(null);
    setPaused(false);
    setBusy(false);
    setManual('');
  }

  function onManual(e: FormEvent) {
    e.preventDefault();
    void handleCode(manual);
  }

  return (
    <div className="col">
      <h2 style={{ marginTop: 0 }}>Scan a label</h2>
      {!pending && <QrScanner onCode={(c) => void handleCode(c)} paused={paused} />}

      <form className="row" onSubmit={onManual}>
        <input
          className="grow"
          placeholder="Or type a code, e.g. OBJ-000123"
          value={manual}
          onChange={(e) => setManual(e.target.value)}
          style={{ padding: 12, borderRadius: 10, background: 'var(--bg)', border: '1px solid var(--border)', color: 'var(--text)' }}
        />
        <button className="btn primary" disabled={busy}>
          Go
        </button>
      </form>

      {pending && <ScanResult code={pending.code} result={pending.result} onClose={reset} />}
    </div>
  );
}

function ScanResult({
  code,
  result,
  onClose,
}: {
  code: string;
  result: ResolveResult | null;
  onClose: () => void;
}) {
  const nav = useNavigate();
  return (
    <div className="card">
      <h3 style={{ marginTop: 0 }}>
        {code}
      </h3>
      {!result && (
        <>
          <p className="muted">This code isn’t registered yet. Register it as a new:</p>
          <div className="row">
            <button className="btn primary grow" onClick={() => nav(`/items/new?code=${encodeURIComponent(code)}`)}>
              Object
            </button>
            <button className="btn primary grow" onClick={() => nav(`/places/new?code=${encodeURIComponent(code)}`)}>
              Place
            </button>
          </div>
        </>
      )}
      {result?.status === 'unassigned' && (
        <>
          <p className="muted">Blank {result.entity_type === 'item' ? 'object' : 'place'} label. Create one now?</p>
          <button
            className="btn primary block"
            onClick={() =>
              nav(`/${result.entity_type === 'item' ? 'items' : 'places'}/new?code=${encodeURIComponent(code)}`)
            }
          >
            Create {result.entity_type === 'item' ? 'object' : 'place'}
          </button>
        </>
      )}
      {result?.status === 'retired' && <p className="muted">This label has been retired.</p>}
      <button className="btn block" style={{ marginTop: 10 }} onClick={onClose}>
        Scan another
      </button>
    </div>
  );
}
