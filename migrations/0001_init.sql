CREATE TABLE settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  timezone TEXT NOT NULL DEFAULT 'Europe/Moscow',
  pinned_actions_json TEXT NOT NULL DEFAULT '[]',
  analysis_context TEXT NOT NULL DEFAULT '',
  llm_provider TEXT NOT NULL DEFAULT 'openrouter',
  llm_base_url TEXT NOT NULL DEFAULT 'https://openrouter.ai/api/v1',
  llm_model TEXT,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  data_revision INTEGER NOT NULL DEFAULT 0 CHECK (data_revision >= 0)
);
INSERT INTO settings (id) VALUES (1);

CREATE TABLE entries (
  id TEXT PRIMARY KEY NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  source_name TEXT,
  kind TEXT NOT NULL DEFAULT 'unknown',
  note TEXT,
  why_me TEXT,
  capture_mode TEXT NOT NULL CHECK (capture_mode IN ('timer', 'manual')),
  time_estimated INTEGER NOT NULL CHECK (time_estimated IN (0, 1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  CHECK (ended_at IS NULL OR ended_at >= started_at)
);
CREATE UNIQUE INDEX entries_single_active_v13
  ON entries ((1)) WHERE ended_at IS NULL;
CREATE INDEX entries_started ON entries (started_at, id);
CREATE INDEX entries_source ON entries (source_name);
CREATE INDEX entries_kind ON entries (kind);

CREATE TABLE day_notes (
  date TEXT PRIMARY KEY NOT NULL,
  planned_minutes INTEGER CHECK (planned_minutes IS NULL OR planned_minutes >= 0),
  available_minutes INTEGER CHECK (available_minutes IS NULL OR available_minutes >= 0),
  outcomes_note TEXT,
  coverage TEXT NOT NULL DEFAULT 'unknown'
    CHECK (coverage IN ('unknown', 'partial', 'full')),
  updated_at INTEGER NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1)
);
