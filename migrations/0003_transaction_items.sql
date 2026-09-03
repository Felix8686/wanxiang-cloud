PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS transaction_items (
  id TEXT PRIMARY KEY,
  transaction_id TEXT NOT NULL,
  name TEXT NOT NULL,
  quantity REAL NOT NULL DEFAULT 1 CHECK (quantity > 0),
  unit_price_fen INTEGER CHECK (unit_price_fen IS NULL OR unit_price_fen >= 0),
  line_total_fen INTEGER NOT NULL CHECK (line_total_fen >= 0),
  category TEXT NOT NULL CHECK (category IN (
    '食品', '饮料', '生鲜', '零食', '日用品', '清洁用品', '个护',
    '医药健康', '母婴', '宠物', '家居', '数码配件', '服饰', '其他'
  )),
  confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  created_at TEXT NOT NULL,
  FOREIGN KEY (transaction_id) REFERENCES transactions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_transaction_items_transaction_id
  ON transaction_items(transaction_id);
CREATE INDEX IF NOT EXISTS idx_transaction_items_category
  ON transaction_items(category);
