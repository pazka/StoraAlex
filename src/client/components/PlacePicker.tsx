import { useState } from 'react';
import { usePlaces } from '../lib/queries.ts';
import { Modal, Spinner } from './ui.tsx';

const PLACE_ICON = '🗄️';

/** Modal list of places to choose a destination/parent. */
export function PlacePicker({
  title,
  excludeId,
  onPick,
  onClose,
}: {
  title: string;
  excludeId?: number;
  onPick: (placeId: number | null) => void;
  onClose: () => void;
}) {
  const [q, setQ] = useState('');
  const places = usePlaces();
  const filtered = (places.data ?? []).filter(
    (p) => p.id !== excludeId && p.name.toLowerCase().includes(q.toLowerCase()),
  );

  return (
    <Modal onClose={onClose}>
      <h3 style={{ marginTop: 0 }}>{title}</h3>
      <input
        placeholder="Search places…"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        style={{ padding: 12, borderRadius: 10, background: 'var(--bg)', border: '1px solid var(--border)', color: 'var(--text)', width: '100%', marginBottom: 12 }}
        autoFocus
      />
      <div style={{ maxHeight: '50vh', overflow: 'auto' }}>
        {places.isLoading && <Spinner />}
        {filtered.map((p) => (
          <button key={p.id} className="list-item" style={{ width: '100%', textAlign: 'left' }} onClick={() => onPick(p.id)}>
            <span className="thumb">{PLACE_ICON}</span>
            <span className="grow">
              <div>{p.name}</div>
              <div className="small muted">{p.code_display}</div>
            </span>
          </button>
        ))}
        {!places.isLoading && filtered.length === 0 && <p className="muted">No places found.</p>}
      </div>
      <button className="btn block" style={{ marginTop: 12 }} onClick={onClose}>
        Cancel
      </button>
    </Modal>
  );
}
