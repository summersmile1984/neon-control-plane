-- 002 §3. Applied by src/store/db.ts at startup; never edit an applied migration, add 0002_*.sql.
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE projects (
  id                        TEXT PRIMARY KEY,
  tenant_id                 TEXT NOT NULL UNIQUE,
  name                      TEXT NOT NULL,
  pg_version                INTEGER NOT NULL,
  region_id                 TEXT NOT NULL DEFAULT 'local',
  platform_id               TEXT NOT NULL DEFAULT 'local',
  provisioner               TEXT NOT NULL DEFAULT 'k8s-pod',
  store_passwords           INTEGER NOT NULL DEFAULT 1,
  history_retention_seconds INTEGER NOT NULL DEFAULT 604800,
  default_branch_id         TEXT,
  settings_json             TEXT NOT NULL DEFAULT '{}',
  annotation_json           TEXT NOT NULL DEFAULT '{}',
  created_at                TEXT NOT NULL,
  updated_at                TEXT NOT NULL,
  deleted_at                TEXT
);

CREATE TABLE branches (
  id                TEXT PRIMARY KEY,
  project_id        TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  timeline_id       TEXT NOT NULL,
  name              TEXT NOT NULL,
  parent_id         TEXT REFERENCES branches(id),
  parent_lsn        TEXT,
  parent_timestamp  TEXT,
  is_default        INTEGER NOT NULL DEFAULT 0,
  protected         INTEGER NOT NULL DEFAULT 0,
  current_state     TEXT NOT NULL DEFAULT 'init',
  pending_state     TEXT,
  state_changed_at  TEXT NOT NULL,
  logical_size      INTEGER,
  annotation_json   TEXT NOT NULL DEFAULT '{}',
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  deleted_at        TEXT,
  UNIQUE (project_id, timeline_id),
  UNIQUE (project_id, name)
);

CREATE TABLE endpoints (
  id                      TEXT PRIMARY KEY,
  project_id              TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  branch_id               TEXT NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  type                    TEXT NOT NULL,
  current_state           TEXT NOT NULL DEFAULT 'init',
  pending_state           TEXT,
  host                    TEXT NOT NULL,
  container_id            TEXT,
  pg_port                 INTEGER NOT NULL,
  http_port               INTEGER NOT NULL,
  suspend_timeout_seconds INTEGER NOT NULL DEFAULT 300,
  autoscaling_min_cu      REAL NOT NULL DEFAULT 0.25,
  autoscaling_max_cu      REAL NOT NULL DEFAULT 0.25,
  settings_json           TEXT NOT NULL DEFAULT '{}',
  disabled                INTEGER NOT NULL DEFAULT 0,
  last_active             TEXT,
  started_at              TEXT,
  suspended_at            TEXT,
  created_at              TEXT NOT NULL,
  updated_at              TEXT NOT NULL,
  deleted_at              TEXT
);
-- Neon allows exactly one read_write compute per branch.
CREATE UNIQUE INDEX endpoints_rw_per_branch
  ON endpoints(branch_id) WHERE type = 'read_write' AND deleted_at IS NULL;

CREATE TABLE roles (
  branch_id           TEXT NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  name                TEXT NOT NULL,
  password_ciphertext TEXT,
  scram_secret        TEXT,
  protected           INTEGER NOT NULL DEFAULT 0,
  no_login            INTEGER NOT NULL DEFAULT 0,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  PRIMARY KEY (branch_id, name)
);

CREATE TABLE databases (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  branch_id  TEXT NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  owner_name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (branch_id, name)
);

CREATE TABLE operations (
  id                TEXT PRIMARY KEY,
  project_id        TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  branch_id         TEXT,
  endpoint_id       TEXT,
  action            TEXT NOT NULL,
  status            TEXT NOT NULL,
  payload_json      TEXT NOT NULL DEFAULT '{}',
  cursor_step       INTEGER NOT NULL DEFAULT 0,
  error             TEXT,
  failures_count    INTEGER NOT NULL DEFAULT 0,
  retry_at          TEXT,
  started_at        TEXT,
  total_duration_ms INTEGER NOT NULL DEFAULT 0,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE INDEX operations_pending ON operations(status, retry_at);
CREATE INDEX operations_by_project ON operations(project_id, created_at DESC);

CREATE TABLE api_keys (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  key_hash     TEXT NOT NULL UNIQUE,
  created_at   TEXT NOT NULL,
  last_used_at TEXT
);

CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
