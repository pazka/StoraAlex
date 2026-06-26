import { useState } from 'react';
import { printLabels } from '../lib/queries.ts';
import { ErrorMsg } from '../components/ui.tsx';
import type { EntityType } from '../../shared/types.ts';

export function LabelsPage() {
  const [type, setType] = useState<EntityType>('item');
  const [count, setCount] = useState(24);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);

  async function generate() {
    setBusy(true);
    setErr(null);
    try {
      await printLabels(type, count);
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="col">
      <h2 style={{ margin: 0 }}>Print labels</h2>
      <p className="small muted">
        Allocate a batch of fresh QR codes and open a printable A4 sheet (24 per page). Stick them on objects or
        places, then scan a blank label to register it.
      </p>

      <div className="card">
        <div className="field">
          <label>Label type</label>
          <div className="seg" style={{ marginBottom: 0 }}>
            <button className={type === 'item' ? 'active' : ''} onClick={() => setType('item')}>
              Object (OBJ-…)
            </button>
            <button className={type === 'place' ? 'active' : ''} onClick={() => setType('place')}>
              Place (PLC-…)
            </button>
          </div>
        </div>
        <div className="field">
          <label htmlFor="count">How many ({1}–{200})</label>
          <input
            id="count"
            type="number"
            min={1}
            max={200}
            value={count}
            onChange={(e) => setCount(Math.max(1, Math.min(200, Number(e.target.value) || 1)))}
          />
        </div>
        <ErrorMsg error={err} />
        <button className="btn primary block" onClick={generate} disabled={busy}>
          {busy ? 'Generating…' : `Generate ${count} ${type === 'item' ? 'object' : 'place'} labels (PDF)`}
        </button>
      </div>

      <div className="notice small">
        The PDF opens in a new tab. If it’s blocked, allow pop-ups for this site. Codes are reserved as soon as you
        generate the sheet — print and use them.
      </div>
    </div>
  );
}
