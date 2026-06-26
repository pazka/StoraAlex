import { Link } from 'react-router-dom';
import {
  useItems,
  usePlaces,
  useSetItemArchived,
  useDeleteItem,
  useSetPlaceArchived,
  useDeletePlace,
} from '../lib/queries.ts';
import { Spinner, ErrorMsg, Thumb } from '../components/ui.tsx';
import { PLACE_ICON } from './Places.tsx';

const smallBtn = { minHeight: 32, padding: '4px 10px' } as const;

export function ArchivePage() {
  const items = useItems({ archived: true });
  const places = usePlaces({ archived: true });
  const setItemArchived = useSetItemArchived();
  const delItem = useDeleteItem();
  const setPlaceArchived = useSetPlaceArchived();
  const delPlace = useDeletePlace();

  const empty = (items.data?.length ?? 0) === 0 && (places.data?.length ?? 0) === 0;

  return (
    <div className="col">
      <div className="row">
        <h2 style={{ margin: 0 }} className="grow">
          Archive
        </h2>
        <Link className="small" to="/admin">
          ‹ Admin
        </Link>
      </div>
      <p className="small muted">Archived things are hidden from the app. Restore them, or delete permanently.</p>

      {(items.isLoading || places.isLoading) && <Spinner />}
      <ErrorMsg error={items.error || places.error || delItem.error || delPlace.error} />
      {empty && <p className="muted">Nothing archived.</p>}

      {(places.data?.length ?? 0) > 0 && <div className="small muted">Places</div>}
      {places.data?.map((p) => (
        <div key={p.id} className="list-item">
          <span className="thumb">{PLACE_ICON}</span>
          <span className="grow">
            <Link to={`/places/${p.id}`}>{p.name}</Link>
            <div className="small muted">{p.code_display}</div>
          </span>
          <button className="btn" style={smallBtn} onClick={() => setPlaceArchived.mutate({ id: p.id, archived: false })}>
            Restore
          </button>
          <button
            className="btn danger"
            style={smallBtn}
            onClick={() => {
              if (window.confirm(`Permanently delete "${p.name}" and everything inside it? This cannot be undone.`)) {
                delPlace.mutate(p.id);
              }
            }}
          >
            Delete
          </button>
        </div>
      ))}

      {(items.data?.length ?? 0) > 0 && (
        <div className="small muted" style={{ marginTop: 8 }}>
          Objects
        </div>
      )}
      {items.data?.map((it) => (
        <div key={it.id} className="list-item">
          <Thumb photoId={it.photo_id} alt={it.name} />
          <span className="grow">
            <Link to={`/items/${it.id}`}>{it.name}</Link>
            <div className="small muted">{it.code_display}</div>
          </span>
          <button className="btn" style={smallBtn} onClick={() => setItemArchived.mutate({ id: it.id, archived: false })}>
            Restore
          </button>
          <button
            className="btn danger"
            style={smallBtn}
            onClick={() => {
              if (window.confirm(`Permanently delete "${it.name}"? This cannot be undone.`)) delItem.mutate(it.id);
            }}
          >
            Delete
          </button>
        </div>
      ))}
    </div>
  );
}
