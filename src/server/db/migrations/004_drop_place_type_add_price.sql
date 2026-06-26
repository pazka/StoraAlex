-- Places no longer carry a unit/shelf/crate "type" — they're just nestable
-- containers. Objects gain an optional price.
ALTER TABLE place DROP COLUMN type;
ALTER TABLE item ADD COLUMN price REAL;
