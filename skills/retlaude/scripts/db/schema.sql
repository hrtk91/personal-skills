-- retlaude SQLite schema
-- 日本語含む全文検索対応 (FTS5 trigram tokenizer, sqlite >= 3.34)

PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;

-- メタデータ + 元JSONの保管
CREATE TABLE IF NOT EXISTS reflections (
  session_id    TEXT PRIMARY KEY,
  date          TEXT NOT NULL,         -- YYYY-MM-DD (ended_at基準)
  project       TEXT,
  cwd           TEXT,
  branch        TEXT,
  summary       TEXT,
  observation   TEXT,                  -- personality_observation
  topics        TEXT,                  -- JSON array as text
  key_insights  TEXT,                  -- JSON array as text
  interests     TEXT,                  -- JSON array as text (interests_candidates)
  ended_at      TEXT,
  indexed_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reflections_date    ON reflections(date);
CREATE INDEX IF NOT EXISTS idx_reflections_project ON reflections(project);
CREATE INDEX IF NOT EXISTS idx_reflections_branch  ON reflections(branch);

-- FTS5検索 (trigram = 日本語の部分一致対応)
CREATE VIRTUAL TABLE IF NOT EXISTS reflections_fts USING fts5(
  session_id UNINDEXED,
  summary,
  observation,
  topics,
  key_insights,
  tokenize = 'trigram'
);

-- アーカイブ(cold storage)も検索可能にする
CREATE TABLE IF NOT EXISTS archive_observations (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  archived_at   TEXT NOT NULL,
  orig_date     TEXT,
  note          TEXT
);
CREATE INDEX IF NOT EXISTS idx_arc_obs_date ON archive_observations(orig_date);

CREATE VIRTUAL TABLE IF NOT EXISTS archive_observations_fts USING fts5(
  id UNINDEXED,
  note,
  tokenize = 'trigram'
);

-- Dreams: 週次/月次のメタ観察
CREATE TABLE IF NOT EXISTS dreams (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  kind          TEXT NOT NULL,           -- 'weekly' | 'monthly'
  period_id     TEXT NOT NULL UNIQUE,    -- e.g. '2026-W19' | '2026-05'
  period_from   TEXT,
  period_to     TEXT,
  summary       TEXT,
  meta_observation TEXT,
  raw_json      TEXT NOT NULL,
  generated_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_dreams_kind ON dreams(kind);

CREATE VIRTUAL TABLE IF NOT EXISTS dreams_fts USING fts5(
  period_id UNINDEXED,
  kind UNINDEXED,
  summary,
  meta_observation,
  raw_json,
  tokenize = 'trigram'
);
