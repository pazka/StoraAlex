import { useEffect, useState, type FormEvent } from 'react';
import { useParams, useSearchParams, useNavigate, Link } from 'react-router-dom';
import { usePlace, useCreatePlace, useUpdatePlace } from '../lib/queries.ts';
import { PhotoInput, Spinner, ErrorMsg } from '../components/ui.tsx';
import { PlacePicker } from '../components/PlacePicker.tsx';
import type { PlaceType } from '../../shared/types.ts';

export function PlaceFormPage() {
  const params = useParams();
  const editId = params.id ? Number(params.id) : undefined;
  const isEdit = editId !== undefined;
  const [search] = useSearchParams();
  const code = search.get('code') ?? undefined;
  const parentParam = search.get('parent') ? Number(search.get('parent')) : null;
  const nav = useNavigate();

  const existing = usePlace(isEdit ? editId : 0);
  const create = useCreatePlace();
  const update = useUpdatePlace(editId ?? 0);

  const [name, setName] = useState('');
  const [type, setType] = useState<PlaceType>('crate');
  const [info, setInfo] = useState('');
  const [photoId, setPhotoId] = useState<number | null>(null);
  const [parentId, setParentId] = useState<number | null>(parentParam);
  const [picking, setPicking] = useState(false);

  useEffect(() => {
    if (isEdit && existing.data) {
      setName(existing.data.name);
      setType(existing.data.type);
      setInfo(existing.data.info ?? '');
      setPhotoId(existing.data.photo_id);
      setParentId(existing.data.parent_place_id);
    }
  }, [isEdit, existing.data]);

  const parent = usePlace(parentId ?? 0);

  if (isEdit && existing.isLoading) return <Spinner />;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (isEdit) {
      await update.mutateAsync({ name, type, info: info || null, photo_id: photoId });
      nav(`/places/${editId}`);
    } else {
      const created = await create.mutateAsync({
        name,
        type,
        info: info || null,
        photo_id: photoId,
        parent_place_id: parentId,
        code_value: code,
        method: code ? 'scan' : 'manual',
      });
      nav(`/places/${created.id}`);
    }
  }

  const busy = create.isPending || update.isPending;

  return (
    <div className="col">
      <Link to={isEdit ? `/places/${editId}` : '/places'} className="small">
        ‹ Back
      </Link>
      <h2 style={{ margin: 0 }}>{isEdit ? 'Edit place' : 'New place'}</h2>
      {code && !isEdit && (
        <div className="notice">
          Label <b>{code}</b> will be attached to this place.
        </div>
      )}

      <form className="card" onSubmit={submit}>
        <div className="field">
          <label htmlFor="n">Name</label>
          <input id="n" value={name} onChange={(e) => setName(e.target.value)} autoFocus required maxLength={200} />
        </div>

        <div className="field">
          <label htmlFor="t">Type</label>
          <select id="t" value={type} onChange={(e) => setType(e.target.value as PlaceType)}>
            <option value="unit">Unit (room / locker)</option>
            <option value="shelf">Shelf</option>
            <option value="crate">Crate / box</option>
          </select>
        </div>

        <div className="field">
          <label>Inside (parent place, optional)</label>
          <div className="row">
            <span className="grow">{parentId ? (parent.data?.name ?? `#${parentId}`) : <span className="muted">Top level</span>}</span>
            <button type="button" className="btn" onClick={() => setPicking(true)}>
              {parentId ? 'Change' : 'Choose'}
            </button>
            {parentId && (
              <button type="button" className="btn danger" onClick={() => setParentId(null)}>
                Clear
              </button>
            )}
          </div>
        </div>

        <PhotoInput value={photoId} onChange={setPhotoId} />

        <div className="field">
          <label htmlFor="info">Info (optional)</label>
          <textarea id="info" value={info} onChange={(e) => setInfo(e.target.value)} maxLength={5000} />
        </div>

        <ErrorMsg error={create.error || update.error} />
        <button className="btn primary block" disabled={busy || !name.trim()}>
          {busy ? 'Saving…' : isEdit ? 'Save changes' : 'Create place'}
        </button>
      </form>

      {picking && (
        <PlacePicker
          title="Inside which place?"
          excludeId={editId}
          onPick={(placeId) => {
            setPicking(false);
            setParentId(placeId);
          }}
          onClose={() => setPicking(false)}
        />
      )}
    </div>
  );
}
