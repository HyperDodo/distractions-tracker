CREATE TABLE llm_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  provider TEXT NOT NULL CHECK (provider IN ('openrouter', 'cheapai', 'custom')),
  base_url TEXT NOT NULL,
  model TEXT NOT NULL,
  encrypted_token TEXT NOT NULL
);
