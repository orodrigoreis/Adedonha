CREATE TABLE IF NOT EXISTS learned_validations (
  category_key TEXT NOT NULL,
  value_key TEXT NOT NULL,
  score INTEGER NOT NULL CHECK (score IN (0, 10)),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (category_key, value_key)
);
