import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

export type DB = DatabaseSync;

const MIGRATIONS_DIR = path.join(import.meta.dirname, 'migrations');

/**
 * Open the SQLite database, apply pragmas, and run any pending migrations.
 * Uses Node's built-in node:sqlite (no native dependency, so it installs
 * cleanly with npm lifecycle scripts disabled — see CLAUDE.md).
 */
export function openDb(dbPath: string): DB {
  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA busy_timeout = 5000;');
  db.exec('PRAGMA synchronous = NORMAL;');
  runMigrations(db);
  return db;
}

function runMigrations(db: DB): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name       TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
  );`);

  const applied = new Set(
    (db.prepare('SELECT name FROM schema_migrations').all() as { name: string }[]).map((r) => r.name),
  );

  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const record = db.prepare('INSERT INTO schema_migrations (name) VALUES (?)');

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    db.exec('BEGIN');
    try {
      db.exec(sql);
      record.run(file);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw new Error(`Migration ${file} failed: ${(err as Error).message}`);
    }
  }
}

// Track nesting depth per database so tx() is re-entrant: SQLite has no nested
// BEGIN, so an inner tx() (e.g. codes.allocate called inside an item-create tx)
// just joins the outer transaction instead of starting a new one.
const txDepth = new WeakMap<object, number>();

// node:sqlite is synchronous; an async callback would COMMIT before its awaited
// work ran and break transaction boundaries. Fail loudly if one is ever passed.
function assertSync(result: unknown): void {
  if (result != null && typeof (result as { then?: unknown }).then === 'function') {
    throw new Error('tx() callback must be synchronous (it returned a thenable)');
  }
}

/** Run a function inside an IMMEDIATE transaction; rolls back on throw. Re-entrant. */
export function tx<T>(db: DB, fn: () => T): T {
  const depth = txDepth.get(db) ?? 0;
  if (depth > 0) {
    // Already inside a transaction — run inline; an inner throw propagates and
    // the outermost tx() rolls everything back.
    txDepth.set(db, depth + 1);
    try {
      const result = fn();
      assertSync(result);
      return result;
    } finally {
      txDepth.set(db, depth);
    }
  }
  db.exec('BEGIN IMMEDIATE');
  txDepth.set(db, 1);
  try {
    const result = fn();
    assertSync(result);
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  } finally {
    txDepth.set(db, 0);
  }
}
