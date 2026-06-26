// Predictable, structured code IDs. NOT a security boundary (see SPEC §2 note):
// every read/write is authenticated; codes are just convenient handles.

export const CODE_PREFIX = {
  item: 'OBJ',
  place: 'PLC',
} as const;

export type EntityType = keyof typeof CODE_PREFIX;

const NUM_WIDTH = 6;

/** Format a numeric sequence value into a display code, e.g. (item, 123) -> "OBJ-000123". */
export function formatCode(entityType: EntityType, seq: number): string {
  return `${CODE_PREFIX[entityType]}-${String(seq).padStart(NUM_WIDTH, '0')}`;
}

const CODE_RE = /^(OBJ|PLC)-(\d{4,})$/;

/** Parse a code value back into its entity type + sequence, or null if malformed. */
export function parseCode(value: string): { entityType: EntityType; seq: number } | null {
  const m = CODE_RE.exec(value.trim().toUpperCase());
  if (!m) return null;
  const prefix = m[1];
  const seq = Number(m[2]);
  const entityType = prefix === 'OBJ' ? 'item' : 'place';
  if (!Number.isSafeInteger(seq)) return null;
  return { entityType, seq };
}

/** True if a string is shaped like one of our codes (cheap pre-check before a DB lookup). */
export function looksLikeCode(value: string): boolean {
  return CODE_RE.test(value.trim().toUpperCase());
}
