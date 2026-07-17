-- Initial schema (docs/ARCHITECTURE.md § Data model).

CREATE TABLE app_settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE vaults (
  id                   TEXT PRIMARY KEY,        -- uuidv7
  name                 TEXT NOT NULL,
  slug                 TEXT NOT NULL UNIQUE,    -- also couch db name suffix
  couch_db_name        TEXT NOT NULL UNIQUE,    -- e.g. vault-<slug>
  e2ee_passphrase_enc  BLOB NOT NULL,           -- encrypted w/ master key
  settings_json        TEXT NOT NULL,           -- LiveSync settings template
  status               TEXT NOT NULL DEFAULT 'active',  -- active|archived|deleting
  created_at           TEXT NOT NULL,
  archived_at          TEXT
);

CREATE TABLE devices (
  id                 TEXT PRIMARY KEY,
  vault_id           TEXT NOT NULL REFERENCES vaults(id),
  name               TEXT NOT NULL,             -- user-assigned label
  platform           TEXT,                      -- desktop|ios|android|unknown
  couch_username     TEXT NOT NULL UNIQUE,      -- per-device CouchDB user
  couch_password_enc BLOB NOT NULL,
  livesync_node_id   TEXT,                      -- inferred, may be null
  status             TEXT NOT NULL DEFAULT 'pending', -- pending|active|revoked
  first_connected    TEXT,
  last_seen          TEXT,
  revoked_at         TEXT,
  created_at         TEXT NOT NULL
);

CREATE TABLE invites (
  id                 TEXT PRIMARY KEY,
  vault_id           TEXT NOT NULL REFERENCES vaults(id),
  device_id          TEXT NOT NULL REFERENCES devices(id),
  token_hash         TEXT NOT NULL UNIQUE,      -- sha256 of URL token
  uri_passphrase_enc BLOB NOT NULL,             -- shown on invite page once
  setup_uri_enc      BLOB NOT NULL,             -- the encrypted obsidian:// URI
  expires_at         TEXT NOT NULL,
  used_at            TEXT,
  created_at         TEXT NOT NULL
);

CREATE TABLE backups (
  id           TEXT PRIMARY KEY,
  vault_id     TEXT NOT NULL REFERENCES vaults(id),
  kind         TEXT NOT NULL,                   -- manual|scheduled
  target       TEXT NOT NULL,                   -- couch-snapshot|filesystem
  location     TEXT NOT NULL,                   -- db name or file path
  status       TEXT NOT NULL,                   -- running|complete|verified|failed
  doc_count    INTEGER,
  size_bytes   INTEGER,
  started_at   TEXT NOT NULL,
  finished_at  TEXT,
  verified_at  TEXT
);

CREATE TABLE health_snapshots (
  id          TEXT PRIMARY KEY,
  vault_id    TEXT REFERENCES vaults(id),       -- null = server-level
  taken_at    TEXT NOT NULL,
  ok          INTEGER NOT NULL,
  detail_json TEXT NOT NULL                     -- doc_count, update_seq, disk, etc.
);

CREATE TABLE events (
  id          TEXT PRIMARY KEY,
  ts          TEXT NOT NULL,
  level       TEXT NOT NULL,                    -- info|warn|error
  actor       TEXT NOT NULL,                    -- admin|system
  vault_id    TEXT,
  device_id   TEXT,
  message     TEXT NOT NULL,                    -- human-readable
  detail_json TEXT
);

CREATE INDEX idx_devices_vault ON devices(vault_id);
CREATE INDEX idx_invites_vault ON invites(vault_id);
CREATE INDEX idx_backups_vault_started ON backups(vault_id, started_at);
CREATE INDEX idx_health_vault_taken ON health_snapshots(vault_id, taken_at);
CREATE INDEX idx_events_ts ON events(ts);
