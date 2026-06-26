-- StorAlex initial schema. SQLite. See SPEC.md §4.
-- All timestamps are ISO-8601 UTC text via datetime('now').

-- Users (no public signup; first user seeded on boot).
CREATE TABLE user (
  id            INTEGER PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  last_login_at TEXT
);

-- Server-side sessions (so logout/revoke works). id = sha256 hex of the
-- random token carried in the signed cookie (token itself never stored).
CREATE TABLE session (
  id         TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  user_agent TEXT
);
CREATE INDEX idx_session_user ON session(user_id);
CREATE INDEX idx_session_expires ON session(expires_at);

-- Stored, downscaled photos (files live under DATA_DIR/media).
CREATE TABLE photo (
  id         INTEGER PRIMARY KEY,
  path       TEXT NOT NULL,          -- relative path under media dir
  width      INTEGER,
  height     INTEGER,
  bytes      INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Storage places, nestable: unit -> shelf -> crate.
CREATE TABLE place (
  id              INTEGER PRIMARY KEY,
  code_display    TEXT NOT NULL,                       -- e.g. PLC-000045
  type            TEXT NOT NULL CHECK (type IN ('unit','shelf','crate')),
  name            TEXT NOT NULL,
  photo_id        INTEGER REFERENCES photo(id) ON DELETE SET NULL,
  info            TEXT,
  parent_place_id INTEGER REFERENCES place(id) ON DELETE SET NULL,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_place_parent ON place(parent_place_id);

-- Objects. location_place_id NULL = out of storage / removed.
CREATE TABLE item (
  id                INTEGER PRIMARY KEY,
  code_display      TEXT NOT NULL,                     -- e.g. OBJ-000123
  name              TEXT NOT NULL,
  photo_id          INTEGER REFERENCES photo(id) ON DELETE SET NULL,
  location_place_id INTEGER REFERENCES place(id) ON DELETE SET NULL,
  notes             TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_item_location ON item(location_place_id);

-- Physical label -> entity resolver. Many codes may point to one entity.
-- Pre-printed but unassigned codes have entity_id NULL and status 'unassigned'.
CREATE TABLE code (
  id          INTEGER PRIMARY KEY,
  code_value  TEXT NOT NULL UNIQUE,                    -- exact string in the QR
  entity_type TEXT NOT NULL CHECK (entity_type IN ('item','place')),
  entity_id   INTEGER,                                 -- NULL while unassigned
  status      TEXT NOT NULL DEFAULT 'unassigned' CHECK (status IN ('unassigned','active','retired')),
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_code_entity ON code(entity_type, entity_id);

-- Monotonic counters for predictable, sequential code values per entity type.
CREATE TABLE code_seq (
  entity_type TEXT PRIMARY KEY CHECK (entity_type IN ('item','place')),
  next_value  INTEGER NOT NULL DEFAULT 1
);
INSERT INTO code_seq (entity_type, next_value) VALUES ('item', 1), ('place', 1);

-- Tags. event = exhibition etc., flag = "important", other = free.
CREATE TABLE tag (
  id    INTEGER PRIMARY KEY,
  name  TEXT NOT NULL UNIQUE,
  color TEXT,
  kind  TEXT NOT NULL DEFAULT 'other' CHECK (kind IN ('event','flag','other'))
);

CREATE TABLE item_tag (
  item_id INTEGER NOT NULL REFERENCES item(id) ON DELETE CASCADE,
  tag_id  INTEGER NOT NULL REFERENCES tag(id) ON DELETE CASCADE,
  PRIMARY KEY (item_id, tag_id)
);

-- Append-only audit log. NEVER updated or deleted.
CREATE TABLE movement (
  id            INTEGER PRIMARY KEY,
  at            TEXT NOT NULL DEFAULT (datetime('now')),
  user_id       INTEGER REFERENCES user(id) ON DELETE SET NULL,
  entity_type   TEXT NOT NULL CHECK (entity_type IN ('item','place')),
  entity_id     INTEGER NOT NULL,
  action        TEXT NOT NULL CHECK (action IN ('created','moved_in','moved_out','relocated','edited','tagged','untagged','retired')),
  from_place_id INTEGER REFERENCES place(id) ON DELETE SET NULL,
  to_place_id   INTEGER REFERENCES place(id) ON DELETE SET NULL,
  method        TEXT NOT NULL CHECK (method IN ('scan','manual')),
  note          TEXT
);
CREATE INDEX idx_movement_entity ON movement(entity_type, entity_id);
CREATE INDEX idx_movement_at ON movement(at);
