-- 0002_sync_metadata.sql
-- Create sync_files table for Obsidian and file sync metadata

CREATE TABLE IF NOT EXISTS sync_files (
  id TEXT PRIMARY KEY,
  path TEXT NOT NULL UNIQUE,
  object_key TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  size_bytes INTEGER NOT NULL DEFAULT 0,
  modified_at TEXT NOT NULL,
  last_source TEXT NOT NULL DEFAULT 'local',
  is_deleted INTEGER NOT NULL DEFAULT 0,
  deleted_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_sync_files_path ON sync_files(path);
CREATE INDEX IF NOT EXISTS idx_sync_files_is_deleted ON sync_files(is_deleted);
CREATE INDEX IF NOT EXISTS idx_sync_files_updated_at ON sync_files(updated_at);
