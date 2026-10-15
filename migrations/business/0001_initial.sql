CREATE TABLE cases (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('case','affair')),
  status TEXT NOT NULL CHECK (status IN ('在办','结案','结案未整卷','解除委托')),
  cause TEXT, case_number TEXT, court TEXT, opened_date TEXT,
  legacy_metadata TEXT,
  metadata_version INTEGER NOT NULL DEFAULT 1,
  document_revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX cases_workspace ON cases(workspace_id,status,kind);
CREATE INDEX cases_name ON cases(workspace_id,name);
CREATE TABLE case_aliases (
  case_id TEXT NOT NULL REFERENCES cases(id), alias TEXT NOT NULL,
  PRIMARY KEY(case_id,alias)
);
CREATE INDEX aliases_lookup ON case_aliases(alias,case_id);
CREATE TABLE log_lines (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL,
  case_id TEXT NOT NULL REFERENCES cases(id), sort_order INTEGER NOT NULL,
  raw_text TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT,
  source_operation_id TEXT NOT NULL
);
CREATE UNIQUE INDEX lines_position ON log_lines(case_id,sort_order) WHERE deleted_at IS NULL;
CREATE INDEX lines_case ON log_lines(workspace_id,case_id,deleted_at,sort_order);
CREATE TABLE line_index (
  line_id TEXT PRIMARY KEY REFERENCES log_lines(id),
  source_line_version INTEGER NOT NULL, parser_version INTEGER NOT NULL,
  kind TEXT NOT NULL, marker TEXT, display_text TEXT NOT NULL,
  record_date TEXT, record_time TEXT, recent_date TEXT,
  todo_state TEXT, due_date TEXT, due_time TEXT,
  event_date TEXT, event_time TEXT, parse_status TEXT NOT NULL,
  diagnostics TEXT NOT NULL
);
CREATE INDEX index_records ON line_index(kind,record_date);
CREATE INDEX index_todos ON line_index(kind,todo_state,due_date);
CREATE INDEX index_events ON line_index(kind,event_date);
CREATE TABLE operations (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, client_id TEXT NOT NULL,
  request_key TEXT NOT NULL, request_hash TEXT NOT NULL, action TEXT NOT NULL,
  result_json TEXT NOT NULL, committed_at TEXT NOT NULL,
  UNIQUE(workspace_id,client_id,request_key)
);
CREATE TABLE write_guards (
  operation_id TEXT PRIMARY KEY REFERENCES operations(id),
  passed INTEGER NOT NULL CONSTRAINT guard_valid CHECK(passed=1)
);
CREATE TABLE audit_changes (
  id TEXT PRIMARY KEY, operation_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL, case_id TEXT NOT NULL,
  line_id TEXT, actor_id TEXT NOT NULL, client_id TEXT NOT NULL,
  source TEXT NOT NULL, action TEXT NOT NULL,
  before_json TEXT, after_json TEXT, created_at TEXT NOT NULL
);
CREATE INDEX audit_case ON audit_changes(workspace_id,case_id,created_at,id);
CREATE TABLE read_snapshots (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, client_id TEXT NOT NULL,
  tool TEXT NOT NULL, query_hash TEXT NOT NULL, payload TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX snapshots_expiry ON read_snapshots(expires_at);
CREATE TABLE read_snapshot_rows (
  snapshot_id TEXT NOT NULL REFERENCES read_snapshots(id) ON DELETE CASCADE,
  position INTEGER NOT NULL, row_json TEXT NOT NULL,
  PRIMARY KEY(snapshot_id,position)
);
CREATE TABLE import_sources (
  source_path TEXT PRIMARY KEY, source_hash TEXT NOT NULL,
  case_id TEXT NOT NULL REFERENCES cases(id), imported_at TEXT NOT NULL,
  source_text TEXT NOT NULL
);
