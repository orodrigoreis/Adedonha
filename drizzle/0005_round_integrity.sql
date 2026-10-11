ALTER TABLE rooms ADD COLUMN round_id TEXT NOT NULL DEFAULT '';
UPDATE rooms SET round_id = lower(hex(randomblob(16))) WHERE round_id = '';

CREATE TABLE learned_validations_scoped (
  host_id TEXT NOT NULL,
  category_key TEXT NOT NULL,
  value_key TEXT NOT NULL,
  score INTEGER NOT NULL CHECK (score IN (0, 10)),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (host_id, category_key, value_key)
);
-- Preserve legacy knowledge without attributing it to an unknown host.
INSERT INTO learned_validations_scoped SELECT '', category_key, value_key, score, updated_at FROM learned_validations;
DROP TABLE learned_validations;
ALTER TABLE learned_validations_scoped RENAME TO learned_validations;
