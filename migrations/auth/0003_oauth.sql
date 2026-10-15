CREATE TABLE IF NOT EXISTS oauth_clients (
  client_id TEXT PRIMARY KEY, issuer TEXT NOT NULL, client_name TEXT NOT NULL,
  redirect_uris TEXT NOT NULL, auth_method TEXT NOT NULL, secret_hash TEXT,
  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS oauth_clients_expiry ON oauth_clients(expires_at);
CREATE TABLE IF NOT EXISTS oauth_requests (
  request_hash TEXT PRIMARY KEY, browser_hash TEXT NOT NULL,
  client_id TEXT NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
  redirect_uri TEXT NOT NULL, resource TEXT NOT NULL, state TEXT,
  challenge TEXT NOT NULL, expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS oauth_requests_expiry ON oauth_requests(expires_at);
CREATE INDEX IF NOT EXISTS oauth_requests_client ON oauth_requests(client_id);
CREATE TABLE IF NOT EXISTS oauth_grants (
  id TEXT PRIMARY KEY, client_id TEXT NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL, resource TEXT NOT NULL, redirect_uri TEXT NOT NULL,
  challenge TEXT NOT NULL, code_hash TEXT UNIQUE, code_expires_at INTEGER NOT NULL,
  access_hash TEXT UNIQUE, access_expires_at INTEGER NOT NULL DEFAULT 0,
  refresh_hash TEXT UNIQUE, expires_at INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS oauth_grants_expiry ON oauth_grants(expires_at);
CREATE INDEX IF NOT EXISTS oauth_grants_client ON oauth_grants(client_id);
CREATE TABLE IF NOT EXISTS oauth_used_refresh_tokens (
  token_hash TEXT PRIMARY KEY, grant_id TEXT NOT NULL REFERENCES oauth_grants(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS oauth_used_refresh_grant ON oauth_used_refresh_tokens(grant_id);
