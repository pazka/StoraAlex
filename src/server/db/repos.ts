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
    list: (): User[] => all<User>('SELECT id, username, created_at, last_login_at FROM user ORDER BY username'),
    delete: (id: number): boolean => run('DELETE FROM user WHERE id = ?', [id]).changes > 0,
    setPassword: (id: number, passwordHash: string): boolean =>
      run('UPDATE user SET password_hash = ? WHERE id = ?', [passwordHash, id]).changes > 0,
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
      name: string;
      photo_id: number | null;
      info: string | null;
      parent_place_id: number | null;
    }): number =>
      num(
        run('INSERT INTO place (code_display, name, photo_id, info, parent_place_id) VALUES (?, ?, ?, ?, ?)', [
          p.code_display,
          p.name,
          p.photo_id,
          p.info,
          p.parent_place_id,
        ]).lastInsertRowid,
      ),
    findById: (id: number): Place | undefined => get<Place>('SELECT * FROM place WHERE id = ?', [id]),
    update: (id: number, patch: Partial<Pick<Place, 'name' | 'info' | 'photo_id'>>): boolean =>
      applyUpdate('place', id, ['name', 'info', 'photo_id'], patch),
    setParent: (id: number, parentId: number | null): void => {
      run("UPDATE place SET parent_place_id = ?, updated_at = datetime('now') WHERE id = ?", [parentId, id]);
    },
    list: (filter: { parent?: number | null; tag?: number; archived?: boolean }): Place[] => {
      const where: string[] = [filter.archived ? 'p.archived_at IS NOT NULL' : 'p.archived_at IS NULL'];
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
      all<Place>('SELECT * FROM place WHERE parent_place_id = ? AND archived_at IS NULL ORDER BY name', [parentId]),
    /** Ancestry from root down to the place itself (for breadcrumbs). */
    breadcrumb: (id: number): PlaceBreadcrumb[] =>
      all<PlaceBreadcrumb>(
        `WITH RECURSIVE anc(id, name, code_display, parent_place_id, depth) AS (
           SELECT id, name, code_display, parent_place_id, 0 FROM place WHERE id = ?
           UNION ALL
           SELECT p.id, p.name, p.code_display, p.parent_place_id, anc.depth + 1
           FROM place p JOIN anc ON p.id = anc.parent_place_id
         )
         SELECT id, name, code_display FROM anc ORDER BY depth DESC`,
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
    setArchived: (id: number, archived: boolean): void => {
      run(
        `UPDATE place SET archived_at = ${archived ? "datetime('now')" : 'NULL'}, updated_at = datetime('now') WHERE id = ?`,
        [id],
      );
    },
    /** All place ids in the subtree rooted at id (including id itself). */
    descendantIds: (id: number): number[] =>
      all<{ id: number }>(
        `WITH RECURSIVE sub(id) AS (
           SELECT id FROM place WHERE id = ?
           UNION ALL
           SELECT p.id FROM place p JOIN sub ON p.parent_place_id = sub.id
         ) SELECT id FROM sub`,
        [id],
      ).map((r) => r.id),
    findByCode: (codeDisplay: string): Place | undefined =>
      get<Place>('SELECT * FROM place WHERE code_display = ?', [codeDisplay]),
    exportRows: (): Record<string, unknown>[] =>
      all<Record<string, unknown>>(
        `SELECT p.code_display AS code, p.name, parent.code_display AS parent_code, p.info,
                CASE WHEN p.archived_at IS NULL THEN 'no' ELSE 'yes' END AS archived
         FROM place p LEFT JOIN place parent ON parent.id = p.parent_place_id
         ORDER BY p.code_display`,
      ),
  };

  /**
   * Permanently delete a place subtree: descendant places AND all items located
   * in them, with their codes/tags. Returns photo paths to unlink. Wrap in a tx.
   */
  function hardDeletePlaceSubtree(rootId: number): {
    photoPaths: string[];
    placesDeleted: number;
    itemsDeleted: number;
  } {
    const ids = places.descendantIds(rootId);
    if (ids.length === 0) return { photoPaths: [], placesDeleted: 0, itemsDeleted: 0 };
    const ph = ids.map(() => '?').join(',');
    const photoIds: number[] = [];

    const itemRows = all<{ id: number; photo_id: number | null }>(
      `SELECT id, photo_id FROM item WHERE location_place_id IN (${ph})`,
      ids,
    );
    const itemIds = itemRows.map((i) => i.id);
    itemRows.forEach((i) => i.photo_id != null && photoIds.push(i.photo_id));
    all<{ photo_id: number | null }>(`SELECT photo_id FROM place WHERE id IN (${ph})`, ids).forEach(
      (r) => r.photo_id != null && photoIds.push(r.photo_id),
    );

    if (itemIds.length) {
      const ip = itemIds.map(() => '?').join(',');
      run(`DELETE FROM code WHERE entity_type = 'item' AND entity_id IN (${ip})`, itemIds);
      run(`DELETE FROM item WHERE id IN (${ip})`, itemIds); // item_tag cascades
    }
    run(`DELETE FROM code WHERE entity_type = 'place' AND entity_id IN (${ph})`, ids);
    run(`DELETE FROM place WHERE id IN (${ph})`, ids); // place_tag cascades

    const photoPaths: string[] = [];
    for (const pid of photoIds) {
      const row = get<{ path: string }>('SELECT path FROM photo WHERE id = ?', [pid]);
      if (row) {
        photoPaths.push(row.path);
        run('DELETE FROM photo WHERE id = ?', [pid]);
      }
    }
    return { photoPaths, placesDeleted: ids.length, itemsDeleted: itemIds.length };
  }

  // ============================ items ============================
  const items = {
    create: (it: {
      code_display: string;
      name: string;
      photo_id: number | null;
      location_place_id: number | null;
      notes: string | null;
      price: number | null;
    }): number =>
      num(
        run(
          'INSERT INTO item (code_display, name, photo_id, location_place_id, notes, price) VALUES (?, ?, ?, ?, ?, ?)',
          [it.code_display, it.name, it.photo_id, it.location_place_id, it.notes, it.price],
        ).lastInsertRowid,
      ),
    findById: (id: number): Item | undefined => get<Item>('SELECT * FROM item WHERE id = ?', [id]),
    update: (id: number, patch: Partial<Pick<Item, 'name' | 'notes' | 'photo_id' | 'price'>>): boolean =>
      applyUpdate('item', id, ['name', 'notes', 'photo_id', 'price'], patch),
    setLocation: (id: number, placeId: number | null): void => {
      run("UPDATE item SET location_place_id = ?, updated_at = datetime('now') WHERE id = ?", [placeId, id]);
    },
    list: (filter: {
      tag?: number;
      place?: number | null;
      status?: 'in' | 'out';
      q?: string;
      archived?: boolean;
    }): Item[] => {
      const where: string[] = [filter.archived ? 'i.archived_at IS NOT NULL' : 'i.archived_at IS NULL'];
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
    clearTags: (itemId: number): void => {
      run('DELETE FROM item_tag WHERE item_id = ?', [itemId]);
    },
    setArchived: (id: number, archived: boolean): void => {
      run(
        `UPDATE item SET archived_at = ${archived ? "datetime('now')" : 'NULL'}, updated_at = datetime('now') WHERE id = ?`,
        [id],
      );
    },
    /** Permanently delete an item: its codes, tag links, and photo. Returns the photo path to unlink. */
    hardDelete: (id: number): { photoPath: string | null } => {
      const photoId = get<{ photo_id: number | null }>('SELECT photo_id FROM item WHERE id = ?', [id])?.photo_id ?? null;
      let photoPath: string | null = null;
      if (photoId != null) {
        const ph = get<{ path: string }>('SELECT path FROM photo WHERE id = ?', [photoId]);
        if (ph) {
          photoPath = ph.path;
          run('DELETE FROM photo WHERE id = ?', [photoId]); // item.photo_id -> NULL via FK
        }
      }
      run("DELETE FROM code WHERE entity_type = 'item' AND entity_id = ?", [id]);
      run('DELETE FROM item WHERE id = ?', [id]); // item_tag cascades
      return { photoPath };
    },
    findByCode: (codeDisplay: string): Item | undefined =>
      get<Item>('SELECT * FROM item WHERE code_display = ?', [codeDisplay]),
    exportRows: (): Record<string, unknown>[] =>
      all<Record<string, unknown>>(
        `SELECT i.code_display AS code, i.name, p.code_display AS place_code, i.price, i.notes,
                CASE WHEN i.archived_at IS NULL THEN 'no' ELSE 'yes' END AS archived,
                (SELECT group_concat(t.name, ', ') FROM item_tag it JOIN tag t ON t.id = it.tag_id WHERE it.item_id = i.id) AS tags
         FROM item i LEFT JOIN place p ON p.id = i.location_place_id
         ORDER BY i.code_display`,
      ),
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
    findByName: (name: string): Tag | undefined => get<Tag>('SELECT * FROM tag WHERE name = ?', [name]),
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

  return { users, sessions, photos, places, items, codes, tags, movements, hardDeletePlaceSubtree };
}

export type Repos = ReturnType<typeof createRepos>;
