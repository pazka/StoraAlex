// DTO types shared between server responses and the client. Kept in sync with
// the DB schema (src/server/db/migrations) and the route schemas.

export type EntityType = 'item' | 'place';
export type CodeStatus = 'unassigned' | 'active' | 'retired';
export type TagKind = 'event' | 'flag' | 'other';
export type MovementMethod = 'scan' | 'manual';
export type MovementAction =
  | 'created'
  | 'moved_in'
  | 'moved_out'
  | 'relocated'
  | 'edited'
  | 'tagged'
  | 'untagged'
  | 'retired'
  | 'archived'
  | 'unarchived';

export interface User {
  id: number;
  username: string;
  created_at: string;
  last_login_at: string | null;
}

export interface Photo {
  id: number;
  width: number | null;
  height: number | null;
  bytes: number | null;
  created_at: string;
}

export interface Place {
  id: number;
  code_display: string;
  name: string;
  photo_id: number | null;
  info: string | null;
  parent_place_id: number | null;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface Item {
  id: number;
  code_display: string;
  name: string;
  photo_id: number | null;
  location_place_id: number | null;
  notes: string | null;
  price: number | null;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface Tag {
  id: number;
  name: string;
  color: string | null;
  kind: TagKind;
}

export interface Code {
  id: number;
  code_value: string;
  entity_type: EntityType;
  entity_id: number | null;
  status: CodeStatus;
  created_at: string;
}

export interface Movement {
  id: number;
  at: string;
  user_id: number | null;
  entity_type: EntityType;
  entity_id: number;
  action: MovementAction;
  from_place_id: number | null;
  to_place_id: number | null;
  method: MovementMethod;
  note: string | null;
}

/** A place plus its ancestry, deepest-last, for breadcrumbs (unit > shelf > crate). */
export interface PlaceBreadcrumb {
  id: number;
  name: string;
  code_display: string;
}

export interface ItemDetail extends Item {
  tags: Tag[];
  location_path: PlaceBreadcrumb[];
}

export interface PlaceDetail extends Place {
  parent_path: PlaceBreadcrumb[];
  child_places: Place[];
  items: Item[];
  tags: Tag[];
}

/** Result of resolving a scanned code. */
export interface ResolveResult {
  code_value: string;
  status: CodeStatus;
  entity_type: EntityType;
  entity_id: number | null;
}
