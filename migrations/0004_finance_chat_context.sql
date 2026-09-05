CREATE TABLE IF NOT EXISTS finance_chat_context (
  chat_id TEXT PRIMARY KEY,
  last_start TEXT NOT NULL,
  last_end TEXT NOT NULL,
  last_label TEXT NOT NULL,
  last_mode TEXT NOT NULL CHECK (last_mode IN ('summary', 'details', 'analysis', 'compare')),
  last_user_text TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_finance_chat_context_updated_at
  ON finance_chat_context(updated_at);
