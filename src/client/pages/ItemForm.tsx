import { useEffect, useState, type FormEvent } from 'react';
import { useParams, useSearchParams, useNavigate, Link } from 'react-router-dom';
import { useItem, useCreateItem, useUpdateItem, usePlace, resolveCode } from '../lib/queries.ts';
import { PhotoInput, Spinner, ErrorMsg, Modal } from '../components/ui.tsx';
import { PlacePicker } from '../components/PlacePicker.tsx';
import { QrScanner } from '../components/Scanner.tsx';

export function ItemFormPage() {
  const params = useParams();
  const editId = params.id ? Number(params.id) : undefined;
  const isEdit = editId !== undefined;
  const [search] = useSearchParams();
  const locParam = search.get('location') ? Number(search.get('location')) : null;
  const nav = useNavigate();
  const [code, setCode] = useState<string | undefined>(search.get('code') ?? undefined);
  const [scanning, setScanning] = useState(false);
  const [scanErr, setScanErr] = useState<string | null>(null);

  async function onScanLabel(raw: string) {
    const c = raw.trim().toUpperCase();
    const r = await resolveCode(c);
    if (!r) return setScanErr(`${c} isn't a registered label.`);
    if (r.entity_type !== 'item') return setScanErr('That label is for a place, not an object.');
    if (r.status !== 'unassigned') return setScanErr('That label is already in use.');
    setCode(c);
    setScanErr(null);
    setScanning(false);
  }

  const existing = useItem(isEdit ? editId : 0);
  const create = useCreateItem();
  const update = useUpdateItem(editId ?? 0);

  const [name, setName] = useState('');
  const [notes, setNotes] = useState('');
  const [price, setPrice] = useState('');
  const [photoId, setPhotoId] = useState<number | null>(null);
  const [locId, setLocId] = useState<number | null>(locParam);
  const [picking, setPicking] = useState(false);

  useEffect(() => {
    if (isEdit && existing.data) {
      setName(existing.data.name);
      setNotes(existing.data.notes ?? '');
      setPrice(existing.data.price != null ? String(existing.data.price) : '');
      setPhotoId(existing.data.photo_id);
      setLocId(existing.data.location_place_id);
    }
  }, [isEdit, existing.data]);

  const priceVal = (() => {
    if (price.trim() === '') return null;
    const n = Number(price);
    return Number.isFinite(n) && n >= 0 ? n : null;
  })();

  const loc = usePlace(locId ?? 0);

  if (isEdit && existing.isLoading) return <Spinner />;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (isEdit) {
      await update.mutateAsync({ name, notes: notes || null, photo_id: photoId, price: priceVal });
      nav(`/items/${editId}`);
    } else {
      const created = await create.mutateAsync({
        name,
        notes: notes || null,
        photo_id: photoId,
        price: priceVal,
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
          <label htmlFor="price">Price (optional, €)</label>
          <input
            id="price"
            type="number"
            inputMode="decimal"
            min={0}
            step="0.01"
            value={price}
            onChange={(e) => setPrice(e.target.value)}
            placeholder="e.g. 129.99"
          />
        </div>

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

      {scanning && (
        <Modal onClose={() => setScanning(false)}>
          <h3 style={{ marginTop: 0 }}>Scan this object’s label</h3>
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
