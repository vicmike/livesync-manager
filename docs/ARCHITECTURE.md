# ARCHITECTURE.md

## Shape of the system

A single self-hosted service (one container) with three responsibilities:

1. **Control plane**: provisions and manages CouchDB databases, users, and
   security objects for LiveSync vaults.
2. **Onboarding**: mints LiveSync setup URIs server-side and serves them as
   short-lived invite pages (QR + deep link).
3. **Operations**: health monitoring, device tracking, backups, restore,
   credential rotation, audit log.

It stores only *metadata and secrets* in its own SQLite database. All note
data lives exclusively in CouchDB, end-to-end encrypted by LiveSync. This app
can be destroyed and rebuilt without any note loss; the only thing that must
be backed up from the app itself is its SQLite file + master key (which
contain the E2EE passphrases and credential material).

```
┌────────────┐   HTTPS    ┌───────────────────┐   admin API   ┌──────────┐
│ Obsidian    │◄──────────►│  CouchDB           │◄─────────────►│ LiveSync │
│ + LiveSync  │  replicate │  (one DB per vault)│               │ Manager  │
└────────────┘            └───────────────────┘               │  (this)  │
      ▲                                                        └────┬─────┘
      │  obsidian://setuplivesync?settings=...                      │
      └─────────────── invite page (QR / link) ─────────────────────┘
```

## Stack and rationale

| Choice | Rationale |
|---|---|
| Node 22 + TypeScript, ESM, strict | Matches owner's ecosystem; `octagonal-wheels` is a JS library, so URI crypto is a direct dependency rather than a port |
| Fastify | Minimal, fast, first-class schema validation hooks; no framework sprawl |
| SQLite (better-sqlite3) | Single-admin app; zero-ops persistence; synchronous API keeps service code simple; WAL mode |
| Plain-fetch CouchDB client | CouchDB's admin API is small; a thin typed wrapper beats a heavy client and keeps error handling explicit |
| React + Vite SPA | Dashboard-style UI with live health data; served as static assets by Fastify in prod, single deployable |
| Vitest | Fast, TS-native |

Deployment target: one Docker image. Reference deployment is Kubernetes
(Traefik ingress, cert-manager TLS) but nothing may assume K8s; plain
`docker run` must work. The binding runtime contract (bind address, `PORT`,
unauthenticated cached `/health`, single `/data` volume, non-root, TLS at the
proxy) and the full env-var table live in `DEPLOYMENT.md`.

## Module layout

```
src/
  config/          # env + config file loading, master key management
  db/              # sqlite bootstrap, migrations runner
  couch/           # typed CouchDB admin client (databases, _users, _security,
                   #   _node config, replication, _active_tasks)
  services/
    vaults.ts      # vault lifecycle (create/connect/archive/delete)
    devices.ts     # device registry, revocation
    vaultNodes.ts  # LiveSync client observations from the milestone doc,
                   #   client ↔ device linking, "last seen", outdated plugins
    invites.ts     # setup-URI generation, invite token lifecycle
    backups.ts     # snapshot/verify/restore orchestration
    health.ts      # pollers + health snapshot evaluation
    events.ts      # audit log
  routes/          # fastify route modules, thin; zod schemas per route
  crypto/          # master-key encryption of secrets at rest; URI encryption
                   #   via octagonal-wheels (wrapped in one module)
web/               # React SPA
migrations/        # 0001_init.sql, ...
reference/         # vendored upstream scripts (documentation only)
```

Modules communicate through service interfaces only. `couch/` knows nothing
about vault semantics; `services/` knows nothing about HTTP.

## Data model (SQLite)

```sql
-- App-level settings and the encrypted secrets envelope metadata
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
  id_derivation_key_enc BLOB,                   -- LiveSync 1.0.33+ ID key, encrypted; NULL = legacy IDs
  settings_json        TEXT NOT NULL,           -- LiveSync settings template
  status               TEXT NOT NULL DEFAULT 'active',  -- active|archived|deleting
  created_at           TEXT NOT NULL,
  archived_at          TEXT
);

CREATE TABLE devices (
  id               TEXT PRIMARY KEY,
  vault_id         TEXT NOT NULL REFERENCES vaults(id),
  name             TEXT NOT NULL,               -- user-assigned label
  platform         TEXT,                        -- desktop|ios|android|unknown
  couch_username   TEXT NOT NULL UNIQUE,        -- per-device CouchDB user
  couch_password_enc BLOB NOT NULL,
  livesync_node_id TEXT,                        -- linked vault_nodes.node_id, may be null
  status           TEXT NOT NULL DEFAULT 'pending', -- pending|active|revoked
  first_connected  TEXT,
  last_seen        TEXT,                        -- follows the linked client's last_connected
  revoked_at       TEXT,
  created_at       TEXT NOT NULL
);
-- UNIQUE (vault_id, livesync_node_id): a client links to one device per vault

-- LiveSync clients observed in a vault's _local/obsydian_livesync_milestone
-- document (LIVESYNC_INTEGRATION.md § 5); refreshed on read, never written back
CREATE TABLE vault_nodes (
  vault_id        TEXT NOT NULL REFERENCES vaults(id),
  node_id         TEXT NOT NULL,                -- LiveSync's random per-install id
  device_name     TEXT,                         -- LiveSync's own device-and-vault name
  vault_name      TEXT,
  plugin_version  TEXT,
  app_version     TEXT,
  platform        TEXT,                         -- newer plugins only
  accepted        INTEGER NOT NULL DEFAULT 1,
  last_connected  TEXT,                         -- ISO, from node_info.last_connected
  first_seen      TEXT NOT NULL,                -- first observed by this app
  last_observed   TEXT NOT NULL,
  PRIMARY KEY (vault_id, node_id)
);

CREATE TABLE invites (
  id             TEXT PRIMARY KEY,
  vault_id       TEXT NOT NULL REFERENCES vaults(id),
  device_id      TEXT NOT NULL REFERENCES devices(id),
  token_hash     TEXT NOT NULL UNIQUE,          -- sha256 of URL token
  uri_passphrase_enc BLOB NOT NULL,             -- shown on invite page once
  setup_uri_enc  BLOB NOT NULL,                 -- the encrypted obsidian:// URI
  expires_at     TEXT NOT NULL,
  used_at        TEXT,
  created_at     TEXT NOT NULL
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
```

## Key design decisions

### One CouchDB database per vault; one CouchDB user per device

Standard LiveSync guides share a single user across all devices. We instead
create a dedicated CouchDB user per device (all listed as members in the vault
DB's `_security` object). Consequences:

- **Revoking a device** = delete/disable that one user. No other device is
  disturbed and no re-onboarding of remaining devices is required.
- **Rotating a device credential** = change one password, reissue one invite.
- Every invite therefore mints: a device row, a CouchDB user, and a setup URI
  embedding that device's credentials.

The E2EE passphrase is necessarily shared across a vault's devices (LiveSync
requirement); revocation removes DB access but a revoked device retains its
local copy and the passphrase; document this honestly in the UI.

### Two CouchDB URLs: admin vs public

The app reaches CouchDB at `COUCHDB_ADMIN_URL` (typically a private address:
a compose service name or a cluster-internal Service DNS name). Setup URIs
embed `COUCHDB_PUBLIC_URL`, the https URL devices replicate against. These
are distinct config values everywhere: in config loading, in `couch/` (which
only ever sees the admin URL), and in `services/invites.ts` (which only ever
embeds the public URL). See `DEPLOYMENT.md` § The two CouchDB URLs.

### Device "last seen" is heuristic

LiveSync records each client's last connection, plugin version and Obsidian
version in the vault's `_local/obsydian_livesync_milestone` document, keyed
by its own random node id (LIVESYNC_INTEGRATION.md § 5). `vaultNodes.ts`
reads that document with the admin account (never writes it), stores the
observations in `vault_nodes`, and links a client to a device when a new
client first appears within the hour after exactly one unlinked device
confirmed its onboarding; anything ambiguous waits for the admin to link by
hand (`PUT /devices/:id/node`). A linked device's `last_seen` follows its
client's `last_connected`. The scheduler refreshes observations hourly and
the vault page on every load. This is best-effort: the UI presents it as
"last seen (approx.)", never as proof that a device is in sync. The same
data flags clients running a plugin older than the minimum recommended
version (`MIN_RECOMMENDED_PLUGIN_VERSION`, currently the 1.0.37 sync-scope
security fix) as a vault health warning.

### Backups are CouchDB-level, verified by count and spot-check

v1 snapshot = one-shot replication `vault-x` → `bk-vault-x-<timestamp>` on the
same server, then verify `doc_count` matches and fetch N random doc IDs from
both. Filesystem export (all_docs + attachments to a tar) is milestone 2 of
backups. Restore never overwrites in place: restore materializes
`vault-x-restored-<ts>`, shows a preview (doc count, latest changes), and the
admin chooses to (a) point new invites at it, or (b) run the destructive
swap flow (lock old DB → rename dance → confirmation token).

### Scheduler

A single in-process interval scheduler (no cron dependency): health polls
every N minutes, scheduled backups daily by default. Missed runs are detected
by comparing `backups.finished_at` freshness, which is also exactly what the
health warning surfaces ("Backups are 9 days old").
