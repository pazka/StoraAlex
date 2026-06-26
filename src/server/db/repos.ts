import type { DB } from './index.js';
import { tx } from './index.js';
import { formatCode } from '../../shared/ids.js';
import type {
  Item,
  Place,
  Tag,
  Code,
  Movement,
  User,
  Photo,
  PlaceBreadcrumb,
  EntityType,
  PlaceType,
  MovementAction,
  MovementMethod,
} from '../../shared/types.js';

// All queries use bound parameters only — never string-interpolated values.
// node:sqlite returns rows as null-prototype objects typed as a generic record,
// so reads go through these helpers that assert the concrete row shape once.

export interface UserRow extends User {
  password_hash: string;
}

export function createRepos(db: DB) {
  const all = <T>(sql: string, params: unknown[] = []): T[] =>
    db.prepare(sql).all(...(params as never[])) as unknown as T[];
  const get = <T>(sql: string, params: unknown[] = []): T | undefined =>
    db.prepare(sql).get(...(params as never[])) as unknown as T | undefined;
  const run = (sql: string, params: unknown[] = []) => db.prepare(sql).run(...(params as never[]));
  const num = (v: unknown): number => Number(v);

  // Build a safe partial UPDATE from an allowlist of columns. Returns true if
  // any updatable field was present (so callers can skip a no-op audit entry).
  function applyUpdate(table: string, id: number, allowed: string[], patch: Record<string, unknown>): boolean {
    const cols = allowed.filter((c) => c in patch);
    if (cols.length === 0) return false;
    const sets = cols.map((c) => `${c} = ?`).concat("updated_at = datetime('now')");
    const values = cols.map((c) => patch[c] ?? null);
    run(`UPDATE ${table} SET ${sets.join(', ')} WHERE id = ?`, [...values, id]);
    return true;
  }

  // ============================ users ============================
  const users = {
    findByUsername: (username: string): UserRow | undefined =>
      get<UserRow>('SELECT * FROM user WHERE username = ?', [username]),
    findById: (id: number): UserRow | undefined => get<UserRow>('SELECT * FROM user WHERE id = ?', [id]),
    create: (username: string, passwordHash: string): number =>
      num(run('INSERT INTO user (username, password_hash) VALUES (?, ?)', [username, passwordHash]).lastInsertRowid),
    touchLogin: (id: number): void => {
      run("UPDATE user SET last_login_at = datetime('now') WHERE id = ?", [id]);
    },
    count: (): number => get<{ n: number }>('SELECT COUNT(*) AS n FROM user')!.n,
  };

  // ============================ sessions ============================
  const sessions = {
    create: (id: string, userId: number, expiresAt: string, userAgent: string | null): void => {
      run('INSERT INTO session (id, user_id, expires_at, user_agent) VALUES (?, ?, ?, ?)', [
        id,
        userId,
        expiresAt,
        userAgent,
      ]);
    },
    /** Returns the owning user iff the session exists and has not expired. */
    findValidUser: (id: string): User | undefined =>
      get<User>(
        `SELECT u.id, u.username, u.created_at, u.last_login_at
         FROM session s JOIN user u ON u.id = s.user_id
         WHERE s.id = ? AND s.expires_at > datetime('now')`,
        [id],
      ),
    delete: (id: string): void => {
      run('DELETE FROM session WHERE id = ?', [id]);
    },
    deleteExpired: (): void => {
      run("DELETE FROM session WHERE expires_at <= datetime('now')");
    },
  };

  // ============================ photos ============================
  const photos = {
    create: (path: string, width: number, height: number, bytes: number): number =>
      num(run('INSERT INTO photo (path, width, height, bytes) VALUES (?, ?, ?, ?)', [path, width, height, bytes]).lastInsertRowid),
    find: (id: number): (Photo & { path: string }) | undefined =>
      get<Photo & { path: string }>('SELECT * FROM photo WHERE id = ?', [id]),
  };

  // ============================ places ============================
  const places = {
    create: (p: {
      code_display: string;
      type: PlaceType;
      name: string;
      photo_id: number | null;
      info: string | null;
      parent_place_id: number | null;
    }): number =>
      num(
        run(
          'INSERT INTO place (code_display, type, name, photo_id, info, parent_place_id) VALUES (?, ?, ?, ?, ?, ?)',
          [p.code_display, p.type, p.name, p.photo_id, p.info, p.parent_place_id],
        ).lastInsertRowid,
      ),
    findById: (id: number): Place | undefined => get<Place>('SELECT * FROM place WHERE id = ?', [id]),
    update: (id: number, patch: Partial<Pick<Place, 'name' | 'info' | 'photo_id' | 'type'>>): boolean =>
      applyUpdate('place', id, ['name', 'info', 'photo_id', 'type'], patch),
    setParent: (id: number, parentId: number | null): void => {
      run("UPDATE place SET parent_place_id = ?, updated_at = datetime('now') WHERE id = ?", [parentId, id]);
    },
    list: (filter: { parent?: number | null; type?: PlaceType; tag?: number }): Place[] => {
      const where: string[] = [];
      const params: unknown[] = [];
      let join = '';
      if (typeof filter.tag === 'number') {
        join = 'JOIN place_tag pt ON pt.place_id = p.id';
        where.push('pt.tag_id = ?');
        params.push(filter.tag);
      }
      if (filter.parent === null) where.push('p.parent_place_id IS NULL');
      else if (typeof filter.parent === 'number') {
        where.push('p.parent_place_id = ?');
        params.push(filter.parent);
      }
      if (filter.type) {
        where.push('p.type = ?');
        params.push(filter.type);
      }
      return all<Place>(
        `SELECT p.* FROM place p ${join} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY p.name`,
        params,
      );
    },
    tags: (placeId: number): Tag[] =>
      all<Tag>('SELECT t.* FROM tag t JOIN place_tag pt ON pt.tag_id = t.id WHERE pt.place_id = ? ORDER BY t.name', [
        placeId,
      ]),
    addTag: (placeId: number, tagId: number): boolean =>
      run('INSERT OR IGNORE INTO place_tag (place_id, tag_id) VALUES (?, ?)', [placeId, tagId]).changes > 0,
    removeTag: (placeId: number, tagId: number): boolean =>
      run('DELETE FROM place_tag WHERE place_id = ? AND tag_id = ?', [placeId, tagId]).changes > 0,
    children: (parentId: number): Place[] =>
      all<Place>('SELECT * FROM place WHERE parent_place_id = ? ORDER BY name', [parentId]),
    /** Ancestry from root down to the place itself (for breadcrumbs). */
    breadcrumb: (id: number): PlaceBreadcrumb[] =>
      all<PlaceBreadcrumb>(
        `WITH RECURSIVE anc(id, name, type, code_display, parent_place_id, depth) AS (
           SELECT id, name, type, code_display, parent_place_id, 0 FROM place WHERE id = ?
           UNION ALL
           SELECT p.id, p.name, p.type, p.code_display, p.parent_place_id, anc.depth + 1
           FROM place p JOIN anc ON p.id = anc.parent_place_id
         )
         SELECT id, name, type, code_display FROM anc ORDER BY depth DESC`,
        [id],
      ),
    /** Walk up from `fromId`; true if `targetId` is on its ancestor chain (or equal). */
    isAncestorOrSelf: (targetId: number, fromId: number): boolean => {
      let cur: number | null = fromId;
      const seen = new Set<number>();
      while (cur !== null) {
        if (cur === targetId) return true;
        if (seen.has(cur)) break; // defensive against pre-existing cycles
        seen.add(cur);
        const parentRow: { parent_place_id: number | null } | undefined = get(
          'SELECT parent_place_id FROM place WHERE id = ?',
          [cur],
        );
        cur = parentRow ? parentRow.parent_place_id : null;
      }
      return false;
    },
  };

  // ============================ items ============================
  const items = {
    create: (it: {
      code_display: string;
      name: string;
      photo_id: number | null;
      location_place_id: number | null;
      notes: string | null;
    }): number =>
      num(
        run('INSERT INTO item (code_display, name, photo_id, location_place_id, notes) VALUES (?, ?, ?, ?, ?)', [
          it.code_display,
          it.name,
          it.photo_id,
          it.location_place_id,
          it.notes,
        ]).lastInsertRowid,
      ),
    findById: (id: number): Item | undefined => get<Item>('SELECT * FROM item WHERE id = ?', [id]),
    update: (id: number, patch: Partial<Pick<Item, 'name' | 'notes' | 'photo_id'>>): boolean =>
      applyUpdate('item', id, ['name', 'notes', 'photo_id'], patch),
    setLocation: (id: number, placeId: number | null): void => {
      run("UPDATE item SET location_place_id = ?, updated_at = datetime('now') WHERE id = ?", [placeId, id]);
    },
    list: (filter: { tag?: number; place?: number | null; status?: 'in' | 'out'; q?: string }): Item[] => {
      const where: string[] = [];
      const params: unknown[] = [];
      let join = '';
      if (typeof filter.tag === 'number') {
        join = 'JOIN item_tag it ON it.item_id = i.id';
        where.push('it.tag_id = ?');
        params.push(filter.tag);
      }
      if (filter.place === null) where.push('i.location_place_id IS NULL');
      else if (typeof filter.place === 'number') {
        where.push('i.location_place_id = ?');
        params.push(filter.place);
      }
      if (filter.status === 'in') where.push('i.location_place_id IS NOT NULL');
      else if (filter.status === 'out') where.push('i.location_place_id IS NULL');
      if (filter.q) {
        where.push('i.name LIKE ? ESCAPE ?');
        params.push('%' + filter.q.replace(/[%_\\]/g, (m) => '\\' + m) + '%', '\\');
      }
      return all<Item>(
        `SELECT i.* FROM item i ${join} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY i.updated_at DESC`,
        params,
      );
    },
    tags: (itemId: number): Tag[] =>
      all<Tag>('SELECT t.* FROM tag t JOIN item_tag it ON it.tag_id = t.id WHERE it.item_id = ? ORDER BY t.name', [
        itemId,
      ]),
    addTag: (itemId: number, tagId: number): boolean =>
      run('INSERT OR IGNORE INTO item_tag (item_id, tag_id) VALUES (?, ?)', [itemId, tagId]).changes > 0,
    removeTag: (itemId: number, tagId: number): boolean =>
      run('DELETE FROM item_tag WHERE item_id = ? AND tag_id = ?', [itemId, tagId]).changes > 0,
  };

  // ============================ codes ============================
  const codes = {
    findByValue: (value: string): Code | undefined => get<Code>('SELECT * FROM code WHERE code_value = ?', [value]),
    listForEntity: (entityType: EntityType, entityId: number): Code[] =>
      all<Code>('SELECT * FROM code WHERE entity_type = ? AND entity_id = ? ORDER BY created_at', [
        entityType,
        entityId,
      ]),
    /** Allocate `count` sequential unassigned codes for an entity type, atomically. */
    allocate: (entityType: EntityType, count: number): Code[] =>
      tx(db, () => {
        const seqRow = get<{ next_value: number }>('SELECT next_value FROM code_seq WHERE entity_type = ?', [
          entityType,
        ])!;
        const start = seqRow.next_value;
        const created: Code[] = [];
        for (let i = 0; i < count; i++) {
          const value = formatCode(entityType, start + i);
          const r = run(
            "INSERT INTO code (code_value, entity_type, entity_id, status) VALUES (?, ?, NULL, 'unassigned')",
            [value, entityType],
          );
          created.push({
            id: num(r.lastInsertRowid),
            code_value: value,
            entity_type: entityType,
            entity_id: null,
            status: 'unassigned',
            created_at: '',
          });
        }
        run('UPDATE code_seq SET next_value = ? WHERE entity_type = ?', [start + count, entityType]);
        return created;
      }),
    /** Attach a code to an entity and activate it. */
    assign: (codeValue: string, entityType: EntityType, entityId: number): void => {
      run("UPDATE code SET entity_id = ?, status = 'active' WHERE code_value = ? AND entity_type = ?", [
        entityId,
        codeValue,
        entityType,
      ]);
    },
    /** Insert a brand-new active code (used when creating an entity from a typed value). */
    createActive: (codeValue: string, entityType: EntityType, entityId: number): void => {
      run("INSERT INTO code (code_value, entity_type, entity_id, status) VALUES (?, ?, ?, 'active')", [
        codeValue,
        entityType,
        entityId,
      ]);
    },
  };

  // ============================ tags ============================
  const tags = {
    create: (name: string, color: string | null, kind: Tag['kind']): number =>
      num(run('INSERT INTO tag (name, color, kind) VALUES (?, ?, ?)', [name, color, kind]).lastInsertRowid),
    list: (): Tag[] => all<Tag>('SELECT * FROM tag ORDER BY kind, name'),
    findById: (id: number): Tag | undefined => get<Tag>('SELECT * FROM tag WHERE id = ?', [id]),
  };

  // ============================ movements (append-only) ============================
  const movements = {
    log: (m: {
      user_id: number | null;
      entity_type: EntityType;
      entity_id: number;
      action: MovementAction;
      from_place_id: number | null;
      to_place_id: number | null;
      method: MovementMethod;
      note: string | null;
    }): void => {
      run(
        `INSERT INTO movement (user_id, entity_type, entity_id, action, from_place_id, to_place_id, method, note)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [m.user_id, m.entity_type, m.entity_id, m.action, m.from_place_id, m.to_place_id, m.method, m.note],
      );
    },
    list: (filter: {
      entity_type?: EntityType;
      entity_id?: number;
      from?: string;
      to?: string;
      limit?: number;
    }): Movement[] => {
      const where: string[] = [];
      const params: unknown[] = [];
      if (filter.entity_type) {
        where.push('entity_type = ?');
        params.push(filter.entity_type);
      }
      if (typeof filter.entity_id === 'number') {
        where.push('entity_id = ?');
        params.push(filter.entity_id);
      }
      if (filter.from) {
        where.push('at >= ?');
        params.push(filter.from);
      }
      if (filter.to) {
        where.push('at <= ?');
        params.push(filter.to);
      }
      const limit = Math.min(Math.max(filter.limit ?? 200, 1), 1000);
      return all<Movement>(
        `SELECT * FROM movement ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY at DESC, id DESC LIMIT ${limit}`,
        params,
      );
    },
  };

  return { users, sessions, photos, places, items, codes, tags, movements };
}

export type Repos = ReturnType<typeof createRepos>;
