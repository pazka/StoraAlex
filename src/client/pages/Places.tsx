import { Link, useSearchParams } from 'react-router-dom';
import { usePlaces, useTags } from '../lib/queries.ts';
import { Spinner, ErrorMsg } from '../components/ui.tsx';

export const PLACE_ICON = '🗄️';

export function PlacesPage() {
  const [params, setParams] = useSearchParams();
  const tag = params.get('tag') ? Number(params.get('tag')) : undefined;
  const tags = useTags();
  const places = usePlaces(tag ? { tag } : { root: true });
  const activeTag = tag ? tags.data?.find((t) => t.id === tag) : undefined;

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
      {activeTag ? (
        <p className="small">
          Places tagged <b>{activeTag.name}</b>{' '}
          <button
            className="btn"
            style={{ minHeight: 28, padding: '2px 10px' }}
            onClick={() => setParams({}, { replace: true })}
          >
            clear
          </button>
        </p>
      ) : (
        <p className="small muted">Top-level storage. Open one to see what’s nested inside.</p>
      )}

      {places.isLoading && <Spinner />}
      <ErrorMsg error={places.error} />
      {places.data?.length === 0 && (
        <p className="muted">{activeTag ? 'No places carry this tag.' : 'No places yet. Tap “New” to register a storage unit.'}</p>
      )}

      {places.data?.map((p) => (
        <Link key={p.id} to={`/places/${p.id}`} className="list-item">
          <span className="thumb">{PLACE_ICON}</span>
          <span className="grow">
            <div>{p.name}</div>
            <div className="small muted">{p.code_display}</div>
          </span>
        </Link>
      ))}
    </div>
  );
}
