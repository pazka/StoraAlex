import { useState, type ReactNode, type ChangeEvent } from 'react';
import { Link } from 'react-router-dom';
import { uploadMedia } from '../lib/api.ts';
import type { PlaceBreadcrumb, Tag } from '../../shared/types.ts';

export const Spinner = () => <div className="spinner" aria-label="loading" />;

export const ErrorMsg = ({ error }: { error: unknown }) =>
  error ? <p className="error">{error instanceof Error ? error.message : String(error)}</p> : null;

export function Field({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="field">
      <label>{label}</label>
      {children}
    </div>
  );
}

export function Thumb({ photoId, alt }: { photoId: number | null; alt?: string }) {
  if (!photoId) return <div className="thumb" aria-hidden>📦</div>;
  return <img className="thumb" src={`/media/${photoId}`} alt={alt ?? ''} />;
}

export function StatusBadge({ inStorage }: { inStorage: boolean }) {
  return <span className={`badge ${inStorage ? 'in' : 'out'}`}>{inStorage ? 'in storage' : 'out'}</span>;
}

export function TagChip({ tag }: { tag: Tag }) {
  return (
    <span className="chip">
      <span className="dot" style={tag.color ? { background: tag.color } : undefined} />
      {tag.name}
    </span>
  );
}

export function Crumbs({ path }: { path: PlaceBreadcrumb[] }) {
  if (path.length === 0) return <span className="crumbs muted">—</span>;
  return (
    <span className="crumbs">
      {path.map((p, i) => (
        <span key={p.id}>
          {i > 0 && ' › '}
          <Link to={`/places/${p.id}`}>
            <b>{p.name}</b>
          </Link>
        </span>
      ))}
    </span>
  );
}

/** Image picker: captures/selects a photo, uploads it, returns the photo id. */
export function PhotoInput({
  value,
  onChange,
}: {
  value: number | null;
  onChange: (photoId: number | null) => void;
}) {
  const [uploading, setUploading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function onPick(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    setErr(null);
    try {
      const { photo_id } = await uploadMedia(file);
      onChange(photo_id);
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : 'upload failed');
    } finally {
      setUploading(false);
    }
  }

  return (
    <div className="field">
      <label>Photo</label>
      <div className="row">
        <Thumb photoId={value} alt="selected" />
        <div className="col grow" style={{ gap: 6 }}>
          <label className="btn" style={{ margin: 0 }}>
            {uploading ? 'Uploading…' : value ? 'Replace photo' : 'Add photo'}
            <input
              type="file"
              accept="image/*"
              capture="environment"
              style={{ display: 'none' }}
              onChange={onPick}
              disabled={uploading}
            />
          </label>
          {value && (
            <button type="button" className="btn danger" onClick={() => onChange(null)}>
              Remove
            </button>
          )}
        </div>
      </div>
      {err && <p className="error">{err}</p>}
    </div>
  );
}

export function Modal({ children, onClose }: { children: ReactNode; onClose: () => void }) {
  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        {children}
      </div>
    </div>
  );
}
