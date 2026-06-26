-- The movement table is the audit trail. Enforce append-only at the storage
-- layer so the invariant survives future code paths / ad-hoc queries, not just
-- the absence of UPDATE/DELETE endpoints. The app only ever INSERTs movements.

CREATE TRIGGER movement_no_update
BEFORE UPDATE ON movement
BEGIN
  SELECT RAISE(ABORT, 'movement is append-only');
END;

CREATE TRIGGER movement_no_delete
BEFORE DELETE ON movement
BEGIN
  SELECT RAISE(ABORT, 'movement is append-only');
END;
