import { useEffect, useState, type FormEvent } from 'react';
import { useParams, useSearchParams, useNavigate, Link } from 'react-router-dom';
import { usePlace, useCreatePlace, useUpdatePlace, resolveCode } from '../lib/queries.ts';
import { PhotoInput, Spinner, ErrorMsg, Modal } from '../components/ui.tsx';
import { PlacePicker } from '../components/PlacePicker.tsx';
import { QrScanner } from '../components/Scanner.tsx';

export function PlaceFormPage() {
  const params = useParams();
  const editId = params.id ? Number(params.id) : undefined;
  const isEdit = editId !== undefined;
  const [search] = useSearchParams();
  const parentParam = search.get('parent') ? Number(search.get('parent')) : null;
  const nav = useNavigate();
  const [code, setCode] = useState<string | undefined>(search.get('code') ?? undefined);
  const [scanning, setScanning] = useState(false);
  const [scanErr, setScanErr] = useState<string | null>(null);

  async function onScanLabel(raw: string) {
    const c = raw.trim().toUpperCase();
    const r = await resolveCode(c);
    if (!r) return setScanErr(`${c} isn't a registered label.`);
    if (r.entity_type !== 'place') return setScanErr('That label is for an object, not a place.');
    if (r.status !== 'unassigned') return setScanErr('That label is already in use.');
    setCode(c);
    setScanErr(null);
    setScanning(false);
  }

  const existing = usePlace(isEdit ? editId : 0);
  const create = useCreatePlace();
  const update = useUpdatePlace(editId ?? 0);

  const [name, setName] = useState('');
  const [info, setInfo] = useState('');
  const [photoId, setPhotoId] = useState<number | null>(null);
  const [parentId, setParentId] = useState<number | null>(parentParam);
  const [picking, setPicking] = useState(false);

  useEffect(() => {
    if (isEdit && existing.data) {
      setName(existing.data.name);
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
      await update.mutateAsync({ name, info: info || null, photo_id: photoId });
      nav(`/places/${editId}`);
    } else {
      const created = await create.mutateAsync({
        name,
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
      {!isEdit && (
        <div className="card" style={{ marginBottom: 0 }}>
          <div className="row">
            <span className="grow small">
              {code ? (
                <>
                  Label <b>{code}</b> will be attached.
                </>
              ) : (
                <span className="muted">A new code will be allocated — or scan a pre-printed label.</span>
              )}
            </span>
            <button
              type="button"
              className="btn"
              onClick={() => {
                setScanErr(null);
                setScanning(true);
              }}
            >
              Scan label
            </button>
            {code && (
              <button type="button" className="btn danger" onClick={() => setCode(undefined)}>
                Clear
              </button>
            )}
          </div>
        </div>
      )}

      <form className="card" onSubmit={submit}>
        <div className="field">
          <label htmlFor="n">Name</label>
          <input id="n" value={name} onChange={(e) => setName(e.target.value)} autoFocus required maxLength={200} />
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

      {scanning && (
        <Modal onClose={() => setScanning(false)}>
          <h3 style={{ marginTop: 0 }}>Scan this place’s label</h3>
          <QrScanner onCode={(c) => void onScanLabel(c)} />
          {scanErr && <p className="error">{scanErr}</p>}
          <button className="btn block" style={{ marginTop: 12 }} onClick={() => setScanning(false)}>
            Cancel
          </button>
        </Modal>
      )}
    </div>
  );
}
