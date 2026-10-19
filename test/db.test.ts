// Characterization of the node:sqlite layer: migrations on a fresh DB, the
// resulting schema, pragmas, and tx() semantics. Guards Node major bumps
// (node:sqlite is built in and still evolving) and SQLite version changes.
import { describe, it, expect, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { openDb, tx, type DB } from '../src/server/db/index.ts';

const open: DB[] = [];
function fresh(dbPath = ':memory:'): DB {
  const db = openDb(dbPath);
  open.push(db);
  return db;
}
afterEach(() => {
  for (const db of open.splice(0)) {
    try {
      db.close();
    } catch {
      /* already closed */
    }
  }
});

const MIGRATIONS = [
  '001_init.sql',
  '002_movement_immutable.sql',
  '003_place_tags.sql',
  '004_drop_place_type_add_price.sql',
  '005_archive.sql',
];

// "<name> <type>[ NOT NULL][ PK][ DEFAULT <expr>]" per column, table_info order.
const SCHEMA: Record<string, string[]> = {
  code: [
    'id INTEGER PK',
    'code_value TEXT NOT NULL',
    'entity_type TEXT NOT NULL',
    'entity_id INTEGER',
    "status TEXT NOT NULL DEFAULT 'unassigned'",
    "created_at TEXT NOT NULL DEFAULT datetime('now')",
  ],
  code_seq: ['entity_type TEXT PK', 'next_value INTEGER NOT NULL DEFAULT 1'],
  item: [
    'id INTEGER PK',
    'code_display TEXT NOT NULL',
    'name TEXT NOT NULL',
    'photo_id INTEGER',
    'location_place_id INTEGER',
    'notes TEXT',
    "created_at TEXT NOT NULL DEFAULT datetime('now')",
    "updated_at TEXT NOT NULL DEFAULT datetime('now')",
    'price REAL',
    'archived_at TEXT',
  ],
  item_tag: ['item_id INTEGER NOT NULL PK', 'tag_id INTEGER NOT NULL PK'],
  movement: [
    'id INTEGER PK',
    "at TEXT NOT NULL DEFAULT datetime('now')",
    'user_id INTEGER',
    'entity_type TEXT NOT NULL',
    'entity_id INTEGER NOT NULL',
    'action TEXT NOT NULL',
    'from_place_id INTEGER',
    'to_place_id INTEGER',
    'method TEXT NOT NULL',
    'note TEXT',
  ],
  photo: [
    'id INTEGER PK',
    'path TEXT NOT NULL',
    'width INTEGER',
    'height INTEGER',
    'bytes INTEGER',
    "created_at TEXT NOT NULL DEFAULT datetime('now')",
  ],
  place: [
    'id INTEGER PK',
    'code_display TEXT NOT NULL',
    'name TEXT NOT NULL',
    'photo_id INTEGER',
    'info TEXT',
    'parent_place_id INTEGER',
    "created_at TEXT NOT NULL DEFAULT datetime('now')",
    "updated_at TEXT NOT NULL DEFAULT datetime('now')",
    'archived_at TEXT',
  ],
  place_tag: ['place_id INTEGER NOT NULL PK', 'tag_id INTEGER NOT NULL PK'],
  schema_migrations: ['name TEXT PK', "applied_at TEXT NOT NULL DEFAULT datetime('now')"],
  session: [
    'id TEXT PK',
    'user_id INTEGER NOT NULL',
    "created_at TEXT NOT NULL DEFAULT datetime('now')",
    'expires_at TEXT NOT NULL',
    'user_agent TEXT',
  ],
  tag: ['id INTEGER PK', 'name TEXT NOT NULL', 'color TEXT', "kind TEXT NOT NULL DEFAULT 'other'"],
  user: [
    'id INTEGER PK',
    'username TEXT NOT NULL',
    'password_hash TEXT NOT NULL',
    "created_at TEXT NOT NULL DEFAULT datetime('now')",
    'last_login_at TEXT',
  ],
};

const INDEXES_AND_TRIGGERS = [
  'index idx_code_entity ON code',
  'index idx_item_location ON item',
  'index idx_movement_at ON movement',
  'index idx_movement_entity ON movement',
  'index idx_place_parent ON place',
  'index idx_session_expires ON session',
  'index idx_session_user ON session',
  'trigger movement_no_delete ON movement',
  'trigger movement_no_update ON movement',
];

const FOREIGN_KEYS: Record<string, string[]> = {
  item: ['location_place_id->place.id SET NULL', 'photo_id->photo.id SET NULL'],
  item_tag: ['item_id->item.id CASCADE', 'tag_id->tag.id CASCADE'],
  place: ['parent_place_id->place.id SET NULL', 'photo_id->photo.id SET NULL'],
  place_tag: ['place_id->place.id CASCADE', 'tag_id->tag.id CASCADE'],
  session: ['user_id->user.id CASCADE'],
};

type Col = { name: string; type: string; notnull: number; pk: number; dflt_value: string | null };

function dumpSchema(db: DB) {
  const tables = (
    db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as {
      name: string;
    }[]
  ).map((t) => t.name);
  const columns: Record<string, string[]> = {};
  const fks: Record<string, string[]> = {};
  for (const t of tables) {
    columns[t] = (db.prepare(`PRAGMA table_info("${t}")`).all() as Col[]).map(
      (c) =>
        `${c.name} ${c.type}${c.notnull ? ' NOT NULL' : ''}${c.pk ? ' PK' : ''}${c.dflt_value != null ? ` DEFAULT ${c.dflt_value}` : ''}`,
    );
    const fk = (db.prepare(`PRAGMA foreign_key_list("${t}")`).all() as { from: string; table: string; to: string; on_delete: string }[])
      .map((f) => `${f.from}->${f.table}.${f.to} ${f.on_delete}`)
      .sort();
    if (fk.length) fks[t] = fk;
  }
  const other = (
    db
      .prepare(
        "SELECT type, name, tbl_name FROM sqlite_master WHERE type IN ('index','trigger') AND name NOT LIKE 'sqlite_%' ORDER BY type, name",
      )
      .all() as { type: string; name: string; tbl_name: string }[]
  ).map((r) => `${r.type} ${r.name} ON ${r.tbl_name}`);
  return { columns, fks, other };
}

describe('migrations on a fresh database', () => {
  it('applies every migration once, in order', () => {
    const db = fresh();
    const rows = db.prepare('SELECT name FROM schema_migrations ORDER BY name').all() as { name: string }[];
    expect(rows.map((r) => r.name)).toEqual(MIGRATIONS);
  });

  it('produces the pinned schema (tables, columns, indexes, triggers, FKs)', () => {
    const { columns, fks, other } = dumpSchema(fresh());
    expect(columns).toEqual(SCHEMA);
    expect(other).toEqual(INDEXES_AND_TRIGGERS);
    expect(fks).toEqual(FOREIGN_KEYS);
  });

  it('seeds the code sequences', () => {
    const rows = fresh().prepare('SELECT entity_type, next_value FROM code_seq ORDER BY entity_type').all();
    expect(rows).toEqual([
      { entity_type: 'item', next_value: 1 },
      { entity_type: 'place', next_value: 1 },
    ]);
  });

  it('re-opening an on-disk database is idempotent and keeps data (WAL, FKs on)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'storalex-db-'));
    const file = path.join(dir, 'nested', 'storalex.db'); // parent dir is created
    const a = openDb(file);
    a.prepare("INSERT INTO tag (name) VALUES ('persisted')").run();
    a.close();

    const b = fresh(file);
    expect(b.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get()).toEqual({ n: MIGRATIONS.length });
    expect(b.prepare('SELECT name FROM tag').all()).toEqual([{ name: 'persisted' }]);
    expect(b.prepare('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'wal' });
    expect(b.prepare('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 });
    expect(b.prepare('PRAGMA busy_timeout').get()).toEqual({ timeout: 5000 });
  });

  it('enforces foreign keys and the append-only movement triggers', () => {
    const db = fresh();
    expect(() => db.prepare("INSERT INTO session (id, user_id, expires_at) VALUES ('s', 999, '2099-01-01')").run()).toThrow(
      /FOREIGN KEY/,
    );
    db.prepare("INSERT INTO movement (entity_type, entity_id, action, method) VALUES ('item', 1, 'created', 'manual')").run();
    expect(() => db.exec("UPDATE movement SET note = 'x'")).toThrow(/append-only/);
    expect(() => db.exec('DELETE FROM movement')).toThrow(/append-only/);
  });
});

describe('node:sqlite driver behaviour the repos rely on', () => {
  it('returns plain objects, numbers for INTEGER, null for NULL, and run() metadata', () => {
    const db = fresh();
    const r = db.prepare("INSERT INTO tag (name, color) VALUES (?, NULL)").run('t1');
    expect(Number(r.lastInsertRowid)).toBe(1);
    expect(r.changes).toBe(1);
    const row = db.prepare('SELECT id, name, color, kind FROM tag WHERE id = ?').get(1);
    expect(row).toEqual({ id: 1, name: 't1', color: null, kind: 'other' });
    expect(typeof (row as { id: unknown }).id).toBe('number');
    expect(db.prepare('SELECT * FROM tag WHERE id = ?').get(42)).toBeUndefined();
  });

  it('reports UNIQUE violations with a message containing "UNIQUE" (routes match on it)', () => {
    const db = fresh();
    db.prepare("INSERT INTO tag (name) VALUES ('dup')").run();
    expect(() => db.prepare("INSERT INTO tag (name) VALUES ('dup')").run()).toThrow(/UNIQUE/);
  });
});

describe('tx()', () => {
  const count = (db: DB) => (db.prepare('SELECT COUNT(*) AS n FROM tag').get() as { n: number }).n;
  const add = (db: DB, name: string) => db.prepare('INSERT INTO tag (name) VALUES (?)').run(name);

  it('commits and returns the callback result', () => {
    const db = fresh();
    expect(tx(db, () => (add(db, 'a'), 'done'))).toBe('done');
    expect(count(db)).toBe(1);
  });

  it('rolls back everything on throw and rethrows the same error', () => {
    const db = fresh();
    const boom = new Error('boom');
    expect(() =>
      tx(db, () => {
        add(db, 'a');
        throw boom;
      }),
    ).toThrow(boom);
    expect(count(db)).toBe(0);
    expect(db.isTransaction).toBe(false);
  });

  it('is re-entrant: a nested tx joins the outer one (no nested BEGIN)', () => {
    const db = fresh();
    tx(db, () => {
      add(db, 'outer');
      tx(db, () => {
        expect(db.isTransaction).toBe(true);
        add(db, 'inner');
      });
    });
    expect(count(db)).toBe(2);
  });

  it('an inner throw that propagates rolls back the outer work too', () => {
    const db = fresh();
    expect(() =>
      tx(db, () => {
        add(db, 'outer');
        tx(db, () => {
          add(db, 'inner');
          throw new Error('inner');
        });
      }),
    ).toThrow('inner');
    expect(count(db)).toBe(0);
  });

  it('an inner throw caught by the outer callback does NOT undo the inner writes (no savepoints)', () => {
    // Characterization, see TESTING.md: nested tx() is a join, not a savepoint.
    const db = fresh();
    tx(db, () => {
      add(db, 'outer');
      try {
        tx(db, () => {
          add(db, 'inner');
          throw new Error('swallowed');
        });
      } catch {
        /* swallowed */
      }
    });
    expect(count(db)).toBe(2);
  });

  it('resets depth after a failure so the next tx() starts a real transaction', () => {
    const db = fresh();
    expect(() => tx(db, () => tx(db, () => { throw new Error('x'); }))).toThrow('x');
    expect(db.isTransaction).toBe(false);
    tx(db, () => add(db, 'after'));
    expect(count(db)).toBe(1);
  });

  it('rejects an async callback and rolls back', () => {
    const db = fresh();
    expect(() =>
      tx(db, async () => {
        add(db, 'a');
      }),
    ).toThrow(/synchronous/);
    expect(count(db)).toBe(0);
  });

  it('uses BEGIN IMMEDIATE (takes the write lock up front)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'storalex-db-'));
    const file = path.join(dir, 'lock.db');
    const a = fresh(file);
    const b = fresh(file);
    b.exec('PRAGMA busy_timeout = 0');
    tx(a, () => {
      // No write yet inside a's transaction, but IMMEDIATE already holds the lock.
      expect(() => b.exec('BEGIN IMMEDIATE')).toThrow(/locked|busy/i);
    });
  });
});
