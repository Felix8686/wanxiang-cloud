PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS finance_fidelity_recovery_log (
  run_id TEXT NOT NULL,
  transaction_id TEXT NOT NULL,
  old_category_id TEXT,
  old_account_id TEXT,
  target_category_name TEXT,
  target_account_name TEXT,
  category_changed INTEGER NOT NULL DEFAULT 0 CHECK (category_changed IN (0, 1)),
  account_changed INTEGER NOT NULL DEFAULT 0 CHECK (account_changed IN (0, 1)),
  evidence_json TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (run_id, transaction_id),
  FOREIGN KEY (transaction_id) REFERENCES transactions(id)
);

CREATE INDEX IF NOT EXISTS idx_finance_fidelity_recovery_run
ON finance_fidelity_recovery_log(run_id);
