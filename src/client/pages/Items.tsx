import { useSearchParams, Link } from 'react-router-dom';
import { useItems, useTags } from '../lib/queries.ts';
import { Spinner, ErrorMsg, Thumb, StatusBadge } from '../components/ui.tsx';

export function ItemsPage() {
  const [params, setParams] = useSearchParams();
  const q = params.get('q') ?? '';
  const status = (params.get('status') as 'in' | 'out' | null) ?? undefined;
  const tag = params.get('tag') ? Number(params.get('tag')) : undefined;

  const tags = useTags();
  const items = useItems({ q: q || undefined, status, tag });

  const setParam = (key: string, value: string | null) => {
    const next = new URLSearchParams(params);
    if (value === null || value === '') next.delete(key);
    else next.set(key, value);
    setParams(next, { replace: true });
  };

  const activeTag = tag ? tags.data?.find((t) => t.id === tag) : undefined;

  return (
    <div>
      <div className="row" style={{ marginBottom: 12 }}>
        <h2 style={{ margin: 0 }} className="grow">
          Objects
        </h2>
        <Link className="btn primary" to="/items/new">
          + New
        </Link>
      </div>

      <input
        placeholder="Search by name…"
        value={q}
        onChange={(e) => setParam('q', e.target.value)}
        style={{ padding: 12, borderRadius: 10, background: 'var(--bg)', border: '1px solid var(--border)', color: 'var(--text)', width: '100%', marginBottom: 12 }}
      />

      <div className="seg">
        {(['all', 'in', 'out'] as const).map((s) => (
          <button
            key={s}
            className={(s === 'all' ? !status : status === s) ? 'active' : ''}
            onClick={() => setParam('status', s === 'all' ? null : s)}
          >
            {s === 'all' ? 'All' : s === 'in' ? 'In storage' : 'Out'}
          </button>
        ))}
      </div>

      {activeTag && (
        <p className="small">
          Filtered by tag <b>{activeTag.name}</b>{' '}
          <button className="btn" style={{ minHeight: 28, padding: '2px 10px' }} onClick={() => setParam('tag', null)}>
            clear
          </button>
        </p>
      )}

      {items.isLoading && <Spinner />}
      <ErrorMsg error={items.error} />
      {items.data?.length === 0 && <p className="muted">No objects yet. Scan a blank label or tap “New”.</p>}

      {items.data?.map((item) => (
        <Link key={item.id} to={`/items/${item.id}`} className="list-item">
          <Thumb photoId={item.photo_id} alt={item.name} />
          <span className="grow">
            <div>{item.name}</div>
            <div className="small muted">{item.code_display}</div>
          </span>
          <StatusBadge inStorage={item.location_place_id != null} />
        </Link>
      ))}
    </div>
  );
}
