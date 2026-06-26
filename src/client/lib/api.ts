export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const opts: RequestInit = { method, credentials: 'same-origin', headers: {} };
  if (body !== undefined) {
    opts.headers = { 'Content-Type': 'application/json' };
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(path, opts);
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('application/json') ? await res.json() : null;
  if (!res.ok) {
    throw new ApiError(res.status, (data && data.error) || res.statusText || 'request failed');
  }
  return data as T;
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body),
  patch: <T>(path: string, body?: unknown) => request<T>('PATCH', path, body),
  del: <T>(path: string) => request<T>('DELETE', path),
};

/** Upload an image via multipart; returns the stored photo id + dimensions. */
export async function uploadMedia(file: File): Promise<{ photo_id: number; width: number; height: number }> {
  const fd = new FormData();
  fd.append('file', file);
  const res = await fetch('/api/media', { method: 'POST', credentials: 'same-origin', body: fd });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, (data && data.error) || 'upload failed');
  return data;
}

export interface ImportSummary {
  tagsCreated: number;
  placesCreated: number;
  placesUpdated: number;
  itemsCreated: number;
  itemsUpdated: number;
  errors: string[];
}

/** Upload an .xlsx workbook to import stock; returns the import summary. */
export async function importXlsx(file: File): Promise<ImportSummary> {
  const fd = new FormData();
  fd.append('file', file);
  const res = await fetch('/api/import.xlsx', { method: 'POST', credentials: 'same-origin', body: fd });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, (data && data.error) || 'import failed');
  return data as ImportSummary;
}

/** POST that returns a binary blob (used for the label-sheet PDF). */
export async function postForBlob(path: string, body: unknown): Promise<Blob> {
  const res = await fetch(path, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw new ApiError(res.status, (data && data.error) || 'request failed');
  }
  return res.blob();
}
