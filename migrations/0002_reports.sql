CREATE TABLE reports (
  id TEXT PRIMARY KEY NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('day', 'week', 'connection_test')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'completed', 'failed', 'unknown', 'deleted')),
  date_from TEXT, date_to_exclusive TEXT, timezone TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, completed_at INTEGER,
  input_revision INTEGER, provider TEXT NOT NULL, model TEXT NOT NULL, prompt_version TEXT NOT NULL,
  input_snapshot_json TEXT, result_json TEXT, error_code TEXT, input_tokens INTEGER, output_tokens INTEGER, cost REAL, deleted_at INTEGER,
  CHECK (kind = 'connection_test' OR (date_from IS NOT NULL AND date_to_exclusive IS NOT NULL AND timezone IS NOT NULL)),
  CHECK (status != 'completed' OR result_json IS NOT NULL),
  CHECK ((status = 'deleted' AND deleted_at IS NOT NULL) OR (status != 'deleted' AND deleted_at IS NULL))
);
CREATE INDEX reports_period ON reports (kind, date_from, created_at, id);
