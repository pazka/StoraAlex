-- Allow tagging places too (not just items), e.g. tag a whole crate for an event.
CREATE TABLE place_tag (
  place_id INTEGER NOT NULL REFERENCES place(id) ON DELETE CASCADE,
  tag_id   INTEGER NOT NULL REFERENCES tag(id) ON DELETE CASCADE,
  PRIMARY KEY (place_id, tag_id)
);
