# API.md: v1 REST surface

Base path: `/api/v1`. JSON everywhere. All endpoints require an authenticated
admin session except `/auth/login`, `GET /health`, and the public invite
endpoints. Every
mutating endpoint writes an audit event.

## Auth

| Method | Path | Notes |
|---|---|---|
| POST | `/auth/setup` | `{password}` → sets the admin password on first boot only (409 afterwards), starts a session. Min 12 chars. |
| POST | `/auth/login` | `{password}` → session cookie (argon2id verify) |
| POST | `/auth/logout` | |
| GET  | `/auth/session` | `{setupRequired, authenticated, session?}`: drives the SPA's setup/login/app state |

Failed `/auth/setup` and `/auth/login` attempts are throttled per client IP
(10 per 15 minutes → 429); failures are audited without secret material.

Sessions: HttpOnly, Secure, SameSite=Lax cookie; server-side session store in
SQLite. Optional config `auth.trustedProxyHeader` allows delegating auth to a
reverse proxy (Authentik/Authelia style). Disabled by default.

## Vaults

| Method | Path | Notes |
|---|---|---|
| GET  | `/vaults` | list (excludes archived unless `?archived=1`) |
| POST | `/vaults` | `{name, encrypted?=true}` → creates DB, security object, settings template; encrypted vaults get an E2EE passphrase and an independent ID key (LiveSync 1.0.33+), returned once as `e2eePassphrase` and `idRecoveryCode` (`sls-id-v1:…`). Returns vault (`idDerivation: true` when keyed). |
| GET  | `/vaults/adoptable` | unmanaged, non-system CouchDB databases (adoption candidates) |
| POST | `/vaults/connect` | adopt an existing CouchDB database: `{name, couchDbName, encrypted?, e2eePassphrase?, idRecoveryCode?}`. `idRecoveryCode` is the plugin's `sls-id-v1:` code when the vault already uses an independent ID key; omit it for legacy vaults. Nothing on the server is modified. Existing `_security` (legacy shared users) stays intact. Whether the db is really LiveSync's is only heuristically checkable (content is obfuscated); adoption verifies existence. |
| GET  | `/vaults/:id` | detail incl. health summary, device count, last backup, `legacyMembers` (unmanaged `_security` names) |
| PATCH| `/vaults/:id` | rename, archive/unarchive |
| DELETE | `/vaults/:id` | destructive (see below) |
| POST | `/vaults/:id/lock` | emergency brake: `_security` swaps to the admin-only sentinel, no device can read or write |
| POST | `/vaults/:id/unlock` | rebuilds `_security` members from the non-revoked device list (legacy members are not restored). If the data changed while locked, every device must run **Reset Synchronisation on This Device** (LiveSync settings → Maintenance), never **Overwrite Server Data with This Device's Files**; the audit event says so |
| POST | `/vaults/:id/members/remove` | remove a legacy `_security` member (confirm-token flow): the last step of migrating an adopted vault to per-device users |

## Devices & onboarding

| Method | Path | Notes |
|---|---|---|
| GET  | `/vaults/:id/devices` | |
| POST | `/vaults/:id/devices` | `{name, platform?}` → creates device (pending) + CouchDB user + invite; returns invite URL |
| POST | `/devices/:id/reinvite` | regenerate invite (rotates that device's CouchDB password, invalidates prior invites) |
| POST | `/devices/:id/revoke` | destructive-lite: disables CouchDB user, marks revoked; requires confirm token |
| PATCH| `/devices/:id` | rename |
| POST | `/devices/:id/connected` | admin confirmation that a pending device is syncing (the invite page's confirm button was skipped) |
| PUT  | `/devices/:id/node` | `{nodeId}` links the device to a LiveSync client seen on its vault (see `GET /vaults/:id/nodes`); `{nodeId: null}` unlinks. 404 for an unseen client, 409 if another device holds it. The linked client's last connection becomes the device's approximate "last seen". Audited |
| GET  | `/vaults/:id/nodes` | LiveSync clients observed in the vault's milestone document (LIVESYNC_INTEGRATION.md § 5): label, plugin/app version, platform where reported, last connection, `outdated` flag (plugin below `minRecommendedPluginVersion`), linked device. Re-reads the document and auto-links unambiguous new clients to recently onboarded devices. `milestone` is `present`, `absent` (no client ever connected) or `unavailable` (CouchDB error; stored observations returned with `error`). Never writes to CouchDB |

### Public invite endpoints (no session)

Served at the server root (`/invite/:token`), not under `/api/v1`, so invite
URLs stay short. Refused over plain HTTP except to localhost.

| Method | Path | Notes |
|---|---|---|
| GET | `/invite/:token` | HTML page: vault name, device name, QR code of the `obsidian://setuplivesync?...` URI, tap-to-open deep link, the URI passphrase, and a prominent "your vault on this device must be EMPTY" warning. Marks nothing. |
| POST | `/invite/:token/consume` | called by the page's "I've imported it" button; marks used. Tokens are single-use and expire (default 15 min). Expired/used → generic 404 page. |

Rate-limit `/invite/*` aggressively; constant-time token compare against
`token_hash`.

## Health

| Method | Path | Notes |
|---|---|---|
| GET | `/health` | app + CouchDB server health, the cached required-configuration status (`config`), and `publicUrl`: the result of probing `COUCHDB_PUBLIC_URL` from the manager with each LiveSync origin (`status` ok/warn/fail/unknown, `server` banner, per-origin HTTP status, CORS headers and actionable `problems`; LIVESYNC_INTEGRATION.md § 2). The overall `status` reflects only the admin connection, so a broken devices' URL never fails the liveness probe. Unauthenticated: it is the container liveness/readiness probe target, so it returns the cached result of the most recent poll and never calls CouchDB synchronously |
| GET | `/vaults/:id/health` | doc count, update_seq, DB size, per-device account-access state, onboarding confirmation, `clients` (count of LiveSync clients seen and those running an outdated plugin; refreshes the observations), backup freshness, warnings[] (human-readable strings). Client activity comes from LiveSync's own milestone document and is approximate; CouchDB itself provides no per-device replication status. |
| GET | `/server/config` | per-key pass/fail against the required CouchDB settings (LIVESYNC_INTEGRATION.md § 2). The key set follows the server version (`couchdbVersion`); size limits are minimums; `required: false` marks informational entries (legacy keys a 3.2+ server ignores) that never fail the check or get fixed |
| POST | `/server/config/fix` | idempotent PUTs for the failing keys. Response carries a `persistence: "unknown"` caveat: on declaratively managed CouchDB installs the fix reverts at the next CouchDB restart (LIVESYNC_INTEGRATION.md § 2). The UI must surface this |

## Backups

| Method | Path | Notes |
|---|---|---|
| GET  | `/vaults/:id/backups` | |
| POST | `/vaults/:id/backups` | manual snapshot now |
| POST | `/backups/:id/verify` | count + spot-check verification |
| GET  | `/backups/:id/restore/preview` | snapshot doc count/size and the `-restored-<ts>` target name |
| POST | `/backups/:id/restore` | materializes `-restored-<ts>` DB (non-destructive; adopt it via `/vaults/connect` to use it) |
| POST | `/backups/:id/restore/swap` | destructive swap: confirm-token flow with `devicesStopped: true`. Locks the vault, keeps a pre-swap snapshot, replaces the live DB, restores device access. Stop LiveSync on every device before confirming; afterwards every device runs **Reset Synchronisation on This Device** (or gets a `flag_fetch.md` in its vault root), never **Overwrite Server Data with This Device's Files**. The `consequences` list and the audit event spell this out. On a mid-swap failure the vault stays locked with both snapshots intact. |
| DELETE | `/backups/:id` | confirm-token flow |

## Events

| Method | Path | Notes |
|---|---|---|
| GET | `/events?vaultId=&level=&before=&limit=` | audit log, newest first |

## Destructive operations: confirmation token flow

Any endpoint marked destructive uses two steps:

1. `POST /.../<action>?dryRun=1` → returns `{confirmToken, consequences: [
   "Database vault-personal (12,431 docs) will be deleted", ...]}`. Token is
   bound to the exact operation + resource, expires in 5 minutes.
2. Same `POST` with `{confirmToken, typedName?}`. Vault deletion additionally
   requires the vault name typed back. Vault deletion offers
   `{backupFirst: true}` (default true).

The server enforces this; the UI cannot bypass it. This implements the
AGENTS.md safety rules as API contract rather than UI convention.

Vault deletion takes a final snapshot first by default (`backupFirst: true`).
The snapshot database survives the deletion, outside the app's
management; the consequences say so. If the snapshot fails, the vault is not
deleted. `backupFirst: false` skips it, and then nothing survives.
