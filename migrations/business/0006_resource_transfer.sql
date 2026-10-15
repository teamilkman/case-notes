CREATE TABLE IF NOT EXISTS resource_transfers (
  source_id TEXT PRIMARY KEY,
  source_worker TEXT NOT NULL,
  snapshot_hash TEXT NOT NULL,
  row_counts TEXT NOT NULL,
  completed_at TEXT NOT NULL,
  retired_at TEXT
);
