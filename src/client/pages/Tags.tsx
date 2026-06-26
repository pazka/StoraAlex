import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useTags, useCreateTag } from '../lib/queries.ts';
import { Spinner, ErrorMsg } from '../components/ui.tsx';
import type { TagKind } from '../../shared/types.ts';

const KIND_LABEL: Record<TagKind, string> = { event: 'Events', flag: 'Flags', other: 'Other' };

export function TagsPage() {
  const tags = useTags();
  const create = useCreateTag();
  const [name, setName] = useState('');
  const [kind, setKind] = useState<TagKind>('event');
  const [color, setColor] = useState('#7bdff2');

  async function submit(e: FormEvent) {
    e.preventDefault();
    await create.mutateAsync({ name: name.trim(), kind, color });
    setName('');
  }

  const grouped = (['event', 'flag', 'other'] as TagKind[]).map((k) => ({
    kind: k,
    items: (tags.data ?? []).filter((t) => t.kind === k),
  }));

  return (
    <div className="col">
      <h2 style={{ margin: 0 }}>Tags</h2>
      <p className="small muted">Tag objects to build instant packing lists for an exhibition or event.</p>

      <form className="card" onSubmit={submit}>
        <div className="field">
          <label htmlFor="tn">New tag name</label>
          <input id="tn" value={name} onChange={(e) => setName(e.target.value)} maxLength={100} placeholder="e.g. Expo 2026" />
        </div>
        <div className="row">
          <div className="field grow" style={{ marginBottom: 0 }}>
            <label htmlFor="tk">Kind</label>
            <select id="tk" value={kind} onChange={(e) => setKind(e.target.value as TagKind)}>
              <option value="event">Event / exhibition</option>
              <option value="flag">Flag (e.g. important)</option>
              <option value="other">Other</option>
            </select>
          </div>
          <div className="field" style={{ marginBottom: 0 }}>
            <label htmlFor="tc">Color</label>
            <input id="tc" type="color" value={color} onChange={(e) => setColor(e.target.value)} style={{ padding: 4, height: 46 }} />
          </div>
        </div>
        <ErrorMsg error={create.error} />
        <button className="btn primary block" style={{ marginTop: 12 }} disabled={create.isPending || !name.trim()}>
          {create.isPending ? 'Adding…' : 'Add tag'}
        </button>
      </form>

      {tags.isLoading && <Spinner />}
      {grouped.map(
        (g) =>
          g.items.length > 0 && (
            <div className="card" key={g.kind}>
              <div className="small muted" style={{ marginBottom: 8 }}>
                {KIND_LABEL[g.kind]}
              </div>
              {g.items.map((t) => (
                <Link key={t.id} to={`/items?tag=${t.id}`} className="list-item">
                  <span className="chip">
                    <span className="dot" style={t.color ? { background: t.color } : undefined} />
                    {t.name}
                  </span>
                  <span className="right small muted">View packing list ›</span>
                </Link>
              ))}
            </div>
          ),
      )}
    </div>
  );
}
