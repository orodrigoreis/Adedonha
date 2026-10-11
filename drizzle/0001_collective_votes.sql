CREATE TABLE IF NOT EXISTS votes (
  room_code TEXT NOT NULL,
  target_player_id TEXT NOT NULL,
  category TEXT NOT NULL,
  voter_id TEXT NOT NULL,
  points INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (room_code, target_player_id, category, voter_id)
);
CREATE INDEX IF NOT EXISTS idx_votes_room_target ON votes(room_code, target_player_id, category);
