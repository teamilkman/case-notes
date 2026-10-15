CREATE TABLE web_sessions (
  token_hash TEXT PRIMARY KEY, workspace_id TEXT NOT NULL,
  expires_at TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX sessions_expiry ON web_sessions(expires_at);
CREATE TABLE login_attempts (
  bucket TEXT PRIMARY KEY, attempts INTEGER NOT NULL,
  resets_at INTEGER NOT NULL
);
