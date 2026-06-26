import { useEffect, useState, type FormEvent } from 'react';
import { useParams, useSearchParams, useNavigate, Link } from 'react-router-dom';
import { useItem, useCreateItem, useUpdateItem, usePlace } from '../lib/queries.ts';
import { PhotoInput, Spinner, ErrorMsg } from '../components/ui.tsx';
import { PlacePicker } from '../components/PlacePicker.tsx';

export function ItemFormPage() {
  const params = useParams();
  const editId = params.id ? Number(params.id) : undefined;
  const isEdit = editId !== undefined;
  const [search] = useSearchParams();
  const code = search.get('code') ?? undefined;
  const locParam = search.get('location') ? Number(search.get('location')) : null;
  const nav = useNavigate();

  const existing = useItem(isEdit ? editId : 0);
  const create = useCreateItem();
  const update = useUpdateItem(editId ?? 0);

  const [name, setName] = useState('');
  const [notes, setNotes] = useState('');
  const [photoId, setPhotoId] = useState<number | null>(null);
  const [locId, setLocId] = useState<number | null>(locParam);
  const [picking, setPicking] = useState(false);

  useEffect(() => {
    if (isEdit && existing.data) {
      setName(existing.data.name);
      setNotes(existing.data.notes ?? '');
      setPhotoId(existing.data.photo_id);
      setLocId(existing.data.location_place_id);
    }
  }, [isEdit, existing.data]);

  const loc = usePlace(locId ?? 0);

  if (isEdit && existing.isLoading) return <Spinner />;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (isEdit) {
      await update.mutateAsync({ name, notes: notes || null, photo_id: photoId });
      nav(`/items/${editId}`);
    } else {
      const created = await create.mutateAsync({
        name,
        notes: notes || null,
        photo_id: photoId,
        location_place_id: locId,
        code_value: code,
        method: code ? 'scan' : 'manual',
      });
      nav(`/items/${created.id}`);
    }
  }

  const busy = create.isPending || update.isPending;

  return (
    <div className="col">
      <Link to={isEdit ? `/items/${editId}` : '/items'} className="small">
        ‹ Back
      </Link>
      <h2 style={{ margin: 0 }}>{isEdit ? 'Edit object' : 'New object'}</h2>
      {code && !isEdit && (
        <div className="notice">
          Label <b>{code}</b> will be attached to this object.
        </div>
      )}

      <form className="card" onSubmit={submit}>
        <div className="field">
          <label htmlFor="n">Name</label>
          <input id="n" value={name} onChange={(e) => setName(e.target.value)} autoFocus required maxLength={200} />
        </div>

        <PhotoInput value={photoId} onChange={setPhotoId} />

        {!isEdit && (
          <div className="field">
            <label>Location</label>
            <div className="row">
              <span className="grow">{locId ? (loc.data?.name ?? `#${locId}`) : <span className="muted">Out of storage</span>}</span>
              <button type="button" className="btn" onClick={() => setPicking(true)}>
                {locId ? 'Change' : 'Choose'}
              </button>
              {locId && (
                <button type="button" className="btn danger" onClick={() => setLocId(null)}>
                  Clear
                </button>
              )}
            </div>
          </div>
        )}

        <div className="field">
          <label htmlFor="notes">Notes (optional)</label>
          <textarea id="notes" value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={5000} />
        </div>

        <ErrorMsg error={create.error || update.error} />
        <button className="btn primary block" disabled={busy || !name.trim()}>
          {busy ? 'Saving…' : isEdit ? 'Save changes' : 'Create object'}
        </button>
      </form>

      {picking && (
        <PlacePicker
          title="Store in…"
          onPick={(placeId) => {
            setPicking(false);
            setLocId(placeId);
          }}
          onClose={() => setPicking(false)}
        />
      )}
    </div>
  );
}
