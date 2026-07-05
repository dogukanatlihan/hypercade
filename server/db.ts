// SQLite (WAL) — schema kept Postgres-portable: TEXT/INTEGER/REAL only,
// no sqlite-isms beyond pragmas. TECH-BRIEF §6.

import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const dbPath = process.env['HYPERCADE_DB'] ?? join(here, 'data', 'hypercade.db');
mkdirSync(dirname(dbPath), { recursive: true });

export const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS profiles (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  nickname TEXT NOT NULL DEFAULT '',
  settings TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  last_seen INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL REFERENCES profiles(id),
  game_id TEXT NOT NULL,
  score REAL NOT NULL,
  duration_ms INTEGER NOT NULL,
  seed INTEGER NOT NULL,
  stats_json TEXT NOT NULL DEFAULT '{}',
  quarantined INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  day TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_runs_daily ON runs(game_id, day, quarantined, score);
CREATE INDEX IF NOT EXISTS idx_runs_profile ON runs(profile_id, created_at);
CREATE TABLE IF NOT EXISTS bests (
  profile_id TEXT NOT NULL REFERENCES profiles(id),
  game_id TEXT NOT NULL,
  score REAL NOT NULL,
  stars INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (profile_id, game_id)
);
CREATE INDEX IF NOT EXISTS idx_bests_board ON bests(game_id, score);
CREATE TABLE IF NOT EXISTS progress (
  profile_id TEXT PRIMARY KEY REFERENCES profiles(id),
  xp INTEGER NOT NULL DEFAULT 0,
  level INTEGER NOT NULL DEFAULT 1,
  streak_json TEXT NOT NULL DEFAULT '{"current":0,"best":0,"shields":0,"lastDay":null}',
  cosmetics_json TEXT NOT NULL DEFAULT '{}',
  meta_enabled INTEGER NOT NULL DEFAULT 0,
  played_games TEXT NOT NULL DEFAULT '[]',
  last_run_day TEXT,
  games_played_today TEXT NOT NULL DEFAULT '[]'
);
CREATE TABLE IF NOT EXISTS badges (
  profile_id TEXT NOT NULL REFERENCES profiles(id),
  badge_id TEXT NOT NULL,
  earned_at INTEGER NOT NULL,
  PRIMARY KEY (profile_id, badge_id)
);
CREATE TABLE IF NOT EXISTS anomalies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  profile_id TEXT,
  game_id TEXT,
  reason TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
`);
