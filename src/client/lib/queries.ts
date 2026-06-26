import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, postForBlob } from './api.ts';
import type {
  Item,
  ItemDetail,
  Place,
  PlaceDetail,
  Tag,
  Movement,
  Code,
  ResolveResult,
  EntityType,
  PlaceType,
  TagKind,
  MovementMethod,
} from '../../shared/types.ts';

const qs = <T extends object>(params: T): string => {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') sp.set(k, String(v));
  const s = sp.toString();
  return s ? `?${s}` : '';
};

// ---------- items ----------
export interface ItemFilter {
  tag?: number;
  place?: number;
  status?: 'in' | 'out';
  q?: string;
}
export const useItems = (filter: ItemFilter = {}) =>
  useQuery({ queryKey: ['items', filter], queryFn: () => api.get<Item[]>(`/api/items${qs(filter)}`) });

export const useItem = (id: number) =>
  useQuery({ queryKey: ['item', id], queryFn: () => api.get<ItemDetail>(`/api/items/${id}`), enabled: id > 0 });

// ---------- places ----------
export const usePlaces = (opts: { parent?: number; root?: boolean; type?: PlaceType; tag?: number } = {}) =>
  useQuery({ queryKey: ['places', opts], queryFn: () => api.get<Place[]>(`/api/places${qs(opts)}`) });

export const usePlace = (id: number) =>
  useQuery({ queryKey: ['place', id], queryFn: () => api.get<PlaceDetail>(`/api/places/${id}`), enabled: id > 0 });

// ---------- tags ----------
export const useTags = () => useQuery({ queryKey: ['tags'], queryFn: () => api.get<Tag[]>('/api/tags') });

// ---------- movements ----------
export const useMovements = (filter: { entity_type?: EntityType; entity_id?: number; limit?: number } = {}) =>
  useQuery({ queryKey: ['movements', filter], queryFn: () => api.get<Movement[]>(`/api/movements${qs(filter)}`) });

// ---------- codes ----------
export const useEntityCodes = (entityType: EntityType, id: number) =>
  useQuery({
    queryKey: ['codes', entityType, id],
    queryFn: () => api.get<Code[]>(`/api/${entityType === 'item' ? 'items' : 'places'}/${id}/codes`),
    enabled: id > 0,
  });

export async function resolveCode(code: string): Promise<ResolveResult | null> {
  try {
    return await api.get<ResolveResult>(`/api/resolve/${encodeURIComponent(code)}`);
  } catch {
    return null;
  }
}

// ---------- mutations ----------
function useInvalidator() {
  const qc = useQueryClient();
  return () => {
    qc.invalidateQueries({ queryKey: ['items'] });
    qc.invalidateQueries({ queryKey: ['places'] });
    qc.invalidateQueries({ queryKey: ['item'] });
    qc.invalidateQueries({ queryKey: ['place'] });
    qc.invalidateQueries({ queryKey: ['movements'] });
  };
}

export interface CreateItemInput {
  name: string;
  notes?: string | null;
  photo_id?: number | null;
  location_place_id?: number | null;
  code_value?: string;
  method?: MovementMethod;
}
export const useCreateItem = () => {
  const inval = useInvalidator();
  return useMutation({
    mutationFn: (body: CreateItemInput) => api.post<ItemDetail>('/api/items', body),
    onSuccess: inval,
  });
};

export const useUpdateItem = (id: number) => {
  const inval = useInvalidator();
  return useMutation({
    mutationFn: (body: { name?: string; notes?: string | null; photo_id?: number | null }) =>
      api.patch<ItemDetail>(`/api/items/${id}`, body),
    onSuccess: inval,
  });
};

export const useMoveItem = (id: number) => {
  const inval = useInvalidator();
  return useMutation({
    mutationFn: (body: { to_place_id: number | null; method?: MovementMethod; note?: string | null }) =>
      api.post<ItemDetail>(`/api/items/${id}/move`, body),
    onSuccess: inval,
  });
};

export const useTagItem = (id: number) => {
  const inval = useInvalidator();
  return useMutation({
    mutationFn: (tag_id: number) => api.post<ItemDetail>(`/api/items/${id}/tags`, { tag_id }),
    onSuccess: inval,
  });
};
export const useUntagItem = (id: number) => {
  const inval = useInvalidator();
  return useMutation({
    mutationFn: (tagId: number) => api.del<ItemDetail>(`/api/items/${id}/tags/${tagId}`),
    onSuccess: inval,
  });
};

export interface CreatePlaceInput {
  name: string;
  type: PlaceType;
  parent_place_id?: number | null;
  info?: string | null;
  photo_id?: number | null;
  code_value?: string;
  method?: MovementMethod;
}
export const useCreatePlace = () => {
  const inval = useInvalidator();
  return useMutation({
    mutationFn: (body: CreatePlaceInput) => api.post<PlaceDetail>('/api/places', body),
    onSuccess: inval,
  });
};

export const useUpdatePlace = (id: number) => {
  const inval = useInvalidator();
  return useMutation({
    mutationFn: (body: { name?: string; info?: string | null; photo_id?: number | null; type?: PlaceType }) =>
      api.patch<PlaceDetail>(`/api/places/${id}`, body),
    onSuccess: inval,
  });
};

export const useMovePlace = (id: number) => {
  const inval = useInvalidator();
  return useMutation({
    mutationFn: (body: { parent_place_id: number | null; method?: MovementMethod }) =>
      api.post<PlaceDetail>(`/api/places/${id}/move`, body),
    onSuccess: inval,
  });
};

export const useTagPlace = (id: number) => {
  const inval = useInvalidator();
  return useMutation({
    mutationFn: (tag_id: number) => api.post<PlaceDetail>(`/api/places/${id}/tags`, { tag_id }),
    onSuccess: inval,
  });
};
export const useUntagPlace = (id: number) => {
  const inval = useInvalidator();
  return useMutation({
    mutationFn: (tagId: number) => api.del<PlaceDetail>(`/api/places/${id}/tags/${tagId}`),
    onSuccess: inval,
  });
};

export const useCreateTag = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { name: string; color?: string | null; kind?: TagKind }) => api.post<Tag>('/api/tags', body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['tags'] }),
  });
};

export const useAssignCode = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { code_value: string; entity_type: EntityType; entity_id: number }) =>
      api.post<{ ok: boolean; codes: Code[] }>('/api/codes/assign', body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['codes'] }),
  });
};

export async function printLabels(type: EntityType, count: number): Promise<void> {
  const blob = await postForBlob('/api/codes/print', { type, count });
  const url = URL.createObjectURL(blob);
  window.open(url, '_blank');
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
