import { useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { usePlace, useMovePlace } from '../lib/queries.ts';
import { Spinner, ErrorMsg, Thumb, Crumbs, StatusBadge } from '../components/ui.tsx';
import { PlacePicker } from '../components/PlacePicker.tsx';
import { TYPE_ICON } from './Places.tsx';

export function PlaceDetailPage() {
  const id = Number(useParams().id);
  const place = usePlace(id);
  const move = useMovePlace(id);
  const [picking, setPicking] = useState(false);

  if (place.isLoading) return <Spinner />;
  if (place.error || !place.data) return <ErrorMsg error={place.error ?? 'not found'} />;
  const p = place.data;

  return (
    <div className="col">
      <Link to="/places" className="small">
        ‹ Places
      </Link>

      <div className="card">
        <div className="row">
          <Thumb photoId={p.photo_id} alt={p.name} />
          <div className="grow">
            <h2 style={{ margin: '0 0 4px' }}>
              {TYPE_ICON[p.type]} {p.name}
            </h2>
            <div className="small muted">
              {p.type} · {p.code_display}
            </div>
          </div>
        </div>
        {p.parent_path.length > 0 && (
          <div className="small" style={{ marginTop: 8 }}>
            Inside: <Crumbs path={p.parent_path} />
          </div>
        )}
        {p.info && <p style={{ marginBottom: 0 }}>{p.info}</p>}
      </div>

      <div className="row">
        <button className="btn grow" onClick={() => setPicking(true)} disabled={move.isPending}>
          Move under…
        </button>
        {p.parent_place_id != null && (
          <button className="btn grow" onClick={() => move.mutate({ parent_place_id: null, method: 'manual' })}>
            Move to top level
          </button>
        )}
      </div>
      <ErrorMsg error={move.error} />

      <div className="card">
        <div className="row" style={{ marginBottom: 8 }}>
          <div className="grow">
            <b>Nested places</b> <span className="muted small">({p.child_places.length})</span>
          </div>
          <Link className="btn" style={{ minHeight: 30, padding: '4px 10px' }} to={`/places/new?parent=${id}`}>
            + Place
          </Link>
        </div>
        {p.child_places.map((c) => (
          <Link key={c.id} to={`/places/${c.id}`} className="list-item">
            <span className="thumb">{TYPE_ICON[c.type]}</span>
            <span className="grow">
              <div>{c.name}</div>
              <div className="small muted">
                {c.type} · {c.code_display}
              </div>
            </span>
          </Link>
        ))}
        {p.child_places.length === 0 && <p className="muted small">Nothing nested here.</p>}
      </div>

      <div className="card">
        <div className="row" style={{ marginBottom: 8 }}>
          <div className="grow">
            <b>Objects here</b> <span className="muted small">({p.items.length})</span>
          </div>
          <Link className="btn" style={{ minHeight: 30, padding: '4px 10px' }} to={`/items/new?location=${id}`}>
            + Object
          </Link>
        </div>
        {p.items.map((it) => (
          <Link key={it.id} to={`/items/${it.id}`} className="list-item">
            <Thumb photoId={it.photo_id} alt={it.name} />
            <span className="grow">
              <div>{it.name}</div>
              <div className="small muted">{it.code_display}</div>
            </span>
            <StatusBadge inStorage />
          </Link>
        ))}
        {p.items.length === 0 && <p className="muted small">No objects stored directly here.</p>}
      </div>

      <Link className="btn block" to={`/places/${id}/edit`}>
        Edit place
      </Link>

      {picking && (
        <PlacePicker
          title="Move under…"
          excludeId={id}
          onPick={(placeId) => {
            setPicking(false);
            move.mutate({ parent_place_id: placeId, method: 'manual' });
          }}
          onClose={() => setPicking(false)}
        />
      )}
    </div>
  );
}
