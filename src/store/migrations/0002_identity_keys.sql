-- M5 identity + API key management (design 004). Applies after 0001; never edit an applied migration.
--
-- api_keys is rebuilt rather than altered: the Neon contract types the key `id` as an integer and
-- the create/list/revoke shapes carry fields 0001 does not have (creator, scope, last-used address,
-- revocation). Local keys are reissued at bootstrap, so there is nothing to preserve.

ALTER TABLE projects ADD COLUMN org_id TEXT;

DROP TABLE api_keys;

CREATE TABLE users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  last_name     TEXT NOT NULL DEFAULT '',
  image         TEXT NOT NULL DEFAULT '',
  password_hash TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE TABLE organizations (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  handle     TEXT NOT NULL,
  plan       TEXT NOT NULL DEFAULT 'free',
  managed_by TEXT NOT NULL DEFAULT 'console',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- MemberRole is the official enum: admin | member | editor | viewer | collaborator.
CREATE TABLE members (
  id        TEXT PRIMARY KEY,
  org_id    TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role      TEXT NOT NULL,
  joined_at TEXT NOT NULL,
  UNIQUE (org_id, user_id)
);
CREATE INDEX members_by_user ON members(user_id);

CREATE TABLE sessions (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);
CREATE INDEX sessions_by_user ON sessions(user_id);

CREATE TABLE api_keys (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  name                 TEXT NOT NULL,
  key_hash             TEXT NOT NULL UNIQUE,
  created_by           TEXT,
  created_at           TEXT NOT NULL,
  last_used_at         TEXT,
  last_used_from_addr  TEXT,
  revoked_at           TEXT,
  kind                 TEXT NOT NULL DEFAULT 'user',
  org_id               TEXT,
  project_id           TEXT
);
CREATE INDEX api_keys_by_user ON api_keys(created_by);
CREATE INDEX api_keys_by_org ON api_keys(kind, org_id);
