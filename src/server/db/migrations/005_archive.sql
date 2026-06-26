-- Soft-archive for items and places (archived_at NULL = active). And extend the
-- movement action enum with 'archived'/'unarchived'. Extending the CHECK means
-- rebuilding the movement table, so drop and recreate its append-only triggers.

ALTER TABLE item ADD COLUMN archived_at TEXT;
ALTER TABLE place ADD COLUMN archived_at TEXT;

DROP TRIGGER IF EXISTS movement_no_update;
DROP TRIGGER IF EXISTS movement_no_delete;

-- No FK references here: this is an append-only audit log, and the append-only
-- triggers would otherwise turn an ON DELETE SET NULL cascade into an aborted
-- UPDATE, blocking deletion of any place/user ever referenced by a movement.
-- The user_id / place ids are kept as historical values.
CREATE TABLE movement_new (
  id            INTEGER PRIMARY KEY,
  at            TEXT NOT NULL DEFAULT (datetime('now')),
  user_id       INTEGER,
  entity_type   TEXT NOT NULL CHECK (entity_type IN ('item','place')),
  entity_id     INTEGER NOT NULL,
  action        TEXT NOT NULL CHECK (action IN ('created','moved_in','moved_out','relocated','edited','tagged','untagged','retired','archived','unarchived')),
  from_place_id INTEGER,
  to_place_id   INTEGER,
  method        TEXT NOT NULL CHECK (method IN ('scan','manual')),
  note          TEXT
);
INSERT INTO movement_new
  SELECT id, at, user_id, entity_type, entity_id, action, from_place_id, to_place_id, method, note FROM movement;
DROP TABLE movement;
ALTER TABLE movement_new RENAME TO movement;

CREATE INDEX idx_movement_entity ON movement(entity_type, entity_id);
CREATE INDEX idx_movement_at ON movement(at);
CREATE TRIGGER movement_no_update BEFORE UPDATE ON movement BEGIN
  SELECT RAISE(ABORT, 'movement is append-only');
END;
CREATE TRIGGER movement_no_delete BEFORE DELETE ON movement BEGIN
  SELECT RAISE(ABORT, 'movement is append-only');
END;
