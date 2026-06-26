import { useState } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import {
  useItem,
  useMoveItem,
  useTagItem,
  useUntagItem,
  useTags,
  useArchiveItem,
  useDeleteItem,
} from '../lib/queries.ts';
import { Spinner, ErrorMsg, Thumb, Crumbs, StatusBadge } from '../components/ui.tsx';
import { PlacePicker } from '../components/PlacePicker.tsx';

export function ItemDetailPage() {
  const id = Number(useParams().id);
  const nav = useNavigate();
  const item = useItem(id);
  const move = useMoveItem(id);
  const tagItem = useTagItem(id);
  const untag = useUntagItem(id);
  const tags = useTags();
  const archive = useArchiveItem(id);
  const del = useDeleteItem();
  const [picking, setPicking] = useState(false);
  const [addingTag, setAddingTag] = useState(false);

  if (item.isLoading) return <Spinner />;
  if (item.error || !item.data) return <ErrorMsg error={item.error ?? 'not found'} />;

  const it = item.data;
  const inStorage = it.location_place_id != null;
  const appliedTagIds = new Set(it.tags.map((t) => t.id));
  const available = (tags.data ?? []).filter((t) => !appliedTagIds.has(t.id));

  return (
    <div className="col">
      <Link to="/items" className="small">
        ‹ Objects
      </Link>

      <div className="card">
        <div className="row">
          <Thumb photoId={it.photo_id} alt={it.name} />
          <div className="grow">
            <h2 style={{ margin: '0 0 4px' }}>{it.name}</h2>
            <div className="small muted">{it.code_display}</div>
          </div>
          <StatusBadge inStorage={inStorage} />
        </div>
        {it.price != null && (
          <p className="small" style={{ marginBottom: it.notes ? 8 : 0 }}>
            Price: <b>€{it.price}</b>
          </p>
        )}
        {it.notes && <p style={{ marginBottom: 0 }}>{it.notes}</p>}
      </div>

      <div className="card">
        <div className="small muted">Location</div>
        <Crumbs path={it.location_path} />
        <div className="row" style={{ marginTop: 12 }}>
          <button className="btn primary grow" onClick={() => setPicking(true)} disabled={move.isPending}>
            {inStorage ? 'Move to…' : 'Place in storage…'}
          </button>
          {inStorage && (
            <button
              className="btn grow"
              onClick={() => move.mutate({ to_place_id: null, method: 'manual' })}
              disabled={move.isPending}
            >
              Take out
            </button>
          )}
        </div>
        <ErrorMsg error={move.error} />
      </div>

      <div className="card">
        <div className="row" style={{ marginBottom: 8 }}>
          <div className="small muted grow">Tags</div>
          <button className="btn" style={{ minHeight: 30, padding: '4px 10px' }} onClick={() => setAddingTag((v) => !v)}>
            + Tag
          </button>
        </div>
        <div className="seg" style={{ marginBottom: 0 }}>
          {it.tags.map((t) => (
            <button key={t.id} className="chip" onClick={() => untag.mutate(t.id)} title="Remove tag">
              <span className="dot" style={t.color ? { background: t.color } : undefined} />
              {t.name} ✕
            </button>
          ))}
          {it.tags.length === 0 && <span className="muted small">No tags.</span>}
        </div>
        {addingTag && (
          <div className="seg" style={{ marginTop: 10 }}>
            {available.map((t) => (
              <button key={t.id} onClick={() => tagItem.mutate(t.id)}>
                + {t.name}
              </button>
            ))}
            {available.length === 0 && (
              <span className="muted small">
                No more tags. <Link to="/tags">Create one</Link>.
              </span>
            )}
          </div>
        )}
      </div>

      <div className="row">
        <Link className="btn grow" to={`/items/${id}/edit`}>
          Edit
        </Link>
        <Link className="btn grow" to={`/history?entity_type=item&entity_id=${id}`}>
          History
        </Link>
      </div>

      {it.archived_at ? (
        <div className="card" style={{ borderColor: 'var(--danger)' }}>
          <div className="small" style={{ marginBottom: 10 }}>
            📦 Archived. Restore it, or delete it permanently.
          </div>
          <div className="row">
            <button className="btn grow" onClick={() => archive.mutate(false)} disabled={archive.isPending}>
              Restore
            </button>
            <button
              className="btn danger grow"
              disabled={del.isPending}
              onClick={() => {
                if (window.confirm(`Permanently delete "${it.name}"? This cannot be undone.`)) {
                  del.mutate(id, { onSuccess: () => nav('/items') });
                }
              }}
            >
              Delete permanently
            </button>
          </div>
          <ErrorMsg error={archive.error || del.error} />
        </div>
      ) : (
        <button className="btn block" onClick={() => archive.mutate(true)} disabled={archive.isPending}>
          Archive
        </button>
      )}

      {picking && (
        <PlacePicker
          title="Place in…"
          onPick={(placeId) => {
            setPicking(false);
            if (placeId != null) move.mutate({ to_place_id: placeId, method: 'manual' });
          }}
          onClose={() => setPicking(false)}
        />
      )}
    </div>
  );
}
