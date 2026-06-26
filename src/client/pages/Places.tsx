import { Link } from 'react-router-dom';
import { usePlaces } from '../lib/queries.ts';
import { Spinner, ErrorMsg } from '../components/ui.tsx';

export const TYPE_ICON: Record<string, string> = { unit: '🏠', shelf: '🗄️', crate: '📦' };

export function PlacesPage() {
  const places = usePlaces({ root: true });
  return (
    <div>
      <div className="row" style={{ marginBottom: 12 }}>
        <h2 style={{ margin: 0 }} className="grow">
          Places
        </h2>
        <Link className="btn primary" to="/places/new">
          + New
        </Link>
      </div>
      <p className="small muted">Top-level storage. Open one to see what’s nested inside.</p>

      {places.isLoading && <Spinner />}
      <ErrorMsg error={places.error} />
      {places.data?.length === 0 && <p className="muted">No places yet. Tap “New” to register a storage unit.</p>}

      {places.data?.map((p) => (
        <Link key={p.id} to={`/places/${p.id}`} className="list-item">
          <span className="thumb">{TYPE_ICON[p.type]}</span>
          <span className="grow">
            <div>{p.name}</div>
            <div className="small muted">
              {p.type} · {p.code_display}
            </div>
          </span>
        </Link>
      ))}
    </div>
  );
}
