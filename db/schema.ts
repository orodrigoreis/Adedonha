export const schemaSql = [
  `CREATE TABLE IF NOT EXISTS rooms (
    code TEXT PRIMARY KEY,
    host_id TEXT NOT NULL,
    categories_json TEXT NOT NULL,
    letter TEXT NOT NULL,
    round_id TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'lobby',
    round_ends_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS players (
    id TEXT PRIMARY KEY,
    room_code TEXT NOT NULL,
    name TEXT NOT NULL,
    auth_token_hash TEXT NOT NULL DEFAULT '',
    joined_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS answers (
    room_code TEXT NOT NULL,
    player_id TEXT NOT NULL,
    category TEXT NOT NULL,
    value TEXT NOT NULL,
    score INTEGER NOT NULL DEFAULT 0,
    validation_status TEXT NOT NULL DEFAULT 'needs_review',
    validation_reason TEXT NOT NULL DEFAULT 'Aguardando conferência automática',
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (room_code, player_id, category)
  )`,
  `CREATE TABLE IF NOT EXISTS votes (
    room_code TEXT NOT NULL,
    target_player_id TEXT NOT NULL,
    category TEXT NOT NULL,
    voter_id TEXT NOT NULL,
    points INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (room_code, target_player_id, category, voter_id)
  )`,
  `CREATE TABLE IF NOT EXISTS learned_validations (
    host_id TEXT NOT NULL,
    category_key TEXT NOT NULL,
    value_key TEXT NOT NULL,
    score INTEGER NOT NULL CHECK (score IN (0, 10)),
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (host_id, category_key, value_key)
  )`,
  "CREATE INDEX IF NOT EXISTS idx_players_room_code ON players(room_code)",
  "CREATE INDEX IF NOT EXISTS idx_answers_room_player ON answers(room_code, player_id)",
  "CREATE INDEX IF NOT EXISTS idx_votes_room_target ON votes(room_code, target_player_id, category)",
];
