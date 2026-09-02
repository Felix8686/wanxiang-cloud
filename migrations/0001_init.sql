PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL DEFAULT 'wallet' CHECK (type IN ('cash', 'bank', 'wallet', 'credit', 'other')),
  currency TEXT NOT NULL DEFAULT 'CNY',
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS categories (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('expense', 'income', 'transfer')),
  parent_id TEXT,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  created_at TEXT NOT NULL,
  FOREIGN KEY (parent_id) REFERENCES categories(id),
  UNIQUE(name, type)
);

CREATE TABLE IF NOT EXISTS transactions (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('expense', 'income', 'transfer')),
  amount_fen INTEGER NOT NULL CHECK (amount_fen > 0),
  currency TEXT NOT NULL DEFAULT 'CNY',
  account_id TEXT,
  category_id TEXT,
  merchant TEXT,
  description TEXT,
  occurred_at TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'api',
  source_id TEXT,
  raw_text TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (account_id) REFERENCES accounts(id),
  FOREIGN KEY (category_id) REFERENCES categories(id),
  UNIQUE(source, source_id)
);

CREATE INDEX IF NOT EXISTS idx_transactions_occurred_at ON transactions(occurred_at);
CREATE INDEX IF NOT EXISTS idx_transactions_type ON transactions(type);
CREATE INDEX IF NOT EXISTS idx_transactions_category_id ON transactions(category_id);

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  due_at TEXT,
  source TEXT NOT NULL DEFAULT 'api',
  metadata_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_events_due_at ON events(due_at);
CREATE INDEX IF NOT EXISTS idx_events_status ON events(status);

CREATE TABLE IF NOT EXISTS ingestion_log (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  source_id TEXT NOT NULL,
  intent TEXT NOT NULL,
  raw_text TEXT,
  status TEXT NOT NULL,
  error_message TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(source, source_id)
);

INSERT OR IGNORE INTO accounts (id, name, type, currency, is_active, created_at)
VALUES ('account-unspecified', '未指定', 'other', 'CNY', 1, CURRENT_TIMESTAMP);

INSERT OR IGNORE INTO categories (id, name, type, parent_id, is_active, created_at) VALUES
  ('cat-expense-food', '餐饮', 'expense', NULL, 1, CURRENT_TIMESTAMP),
  ('cat-expense-daily', '日用品', 'expense', NULL, 1, CURRENT_TIMESTAMP),
  ('cat-expense-transport', '交通', 'expense', NULL, 1, CURRENT_TIMESTAMP),
  ('cat-expense-other', '其他支出', 'expense', NULL, 1, CURRENT_TIMESTAMP),
  ('cat-income-salary', '工资', 'income', NULL, 1, CURRENT_TIMESTAMP),
  ('cat-income-other', '其他收入', 'income', NULL, 1, CURRENT_TIMESTAMP),
  ('cat-transfer', '转账', 'transfer', NULL, 1, CURRENT_TIMESTAMP);
