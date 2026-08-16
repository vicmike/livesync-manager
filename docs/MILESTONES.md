# MILESTONES.md

Each milestone is one PR (or a small stack). A milestone is done per
AGENTS.md: tests, docs, no silent data destruction, actionable errors, UI
explains what happened. Work strictly in order; later milestones assume
earlier contracts.

## M0: Scaffold
Repo layout per ARCHITECTURE.md; TypeScript strict; Fastify hello-world;
Vite/React shell; eslint/prettier; vitest; `dev/couchdb.yml` docker-compose
for integration tests; multi-stage Dockerfile (non-root, `/data` volume,
honoring the DEPLOYMENT.md runtime contract); CI (lint + test + build).
CI image build + push joined at the dogfood checkpoint: the `image` job in
`.forgejo/workflows/ci.yml` triggers the in-cluster kaniko CronJob and rolls
out the console. Update CLAUDE.md commands section.

## M1: Config, master key, SQLite
Config loading (env + file); master key generate/load; `src/crypto`
(AES-256-GCM envelope with AAD, round-trip tests); migrations runner +
`0001_init.sql` implementing the full schema; `app_settings`.

## M2: Auth
Admin password set-on-first-boot flow; argon2id; session store; login/logout
routes; auth guard plugin; security headers (HSTS, CSP, cookie flags).

## M3: CouchDB client + server health
Typed fetch wrapper (db CRUD, `_users`, `_security`, `_node` config,
`_replicate`, `_active_tasks`); "check server configuration" service
verifying the § 2 settings from LIVESYNC_INTEGRATION.md with one-click fix;
`GET /health`; integration tests against Docker CouchDB.

## M4: Vault lifecycle
Create (DB + `_security` + E2EE passphrase + settings template + events);
list/detail/rename; archive; delete with confirm-token flow + backup-first
default (backup can stub to snapshot from M7; if building before M7, delete
is blocked behind a feature flag). Connect-existing-vault comes later (M10).

## M5: Setup URI generation + invites
`octagonal-wheels` dependency pinned; URI builder from vault template +
device credentials; round-trip decrypt test; invite service (token hash,
TTL, single-use); public invite page (QR, deep link, passphrase display,
empty-vault warning); rate limiting.

## M6: Devices
Add-device flow (device + CouchDB user + `_security` update + invite);
reinvite (password rotation); revoke (confirm-token; disable user, rewrite
`_security`); pending→active transition; last-seen inference (best-effort).

## Checkpoint after M6 (Dogfood: real deployment)
Not a PR, a validation gate on M1-M6 against a real cluster. Deploy the
image to production Kubernetes (RWO local-block PVC, `Recreate`, probes on
`/health`, TLS ingress with forwarded headers; DEPLOYMENT.md § Kubernetes),
pointed at the live CouchDB. Create fresh vaults through the app and
re-onboard every device via invite links (device-with-notes into an empty
vault DB is the safe merge direction). Retire any legacy shared database
only after the new vaults are verified syncing and an independent backup of
the old database is confirmed. Friction found here files as issues before M7.

## M7 (Backups: snapshot + verify)
Snapshot via one-shot replication; poll to completion; verification (counts +
spot-check); manual trigger endpoint; scheduler with daily default; backup
freshness feeds health warnings; vault deletion honors backup-first (retires
the pre-M7 feature flag). Backup UI ships with the dashboard in M8.

## M8: Dashboard UI
The four AGENTS.md questions above the fold: notes safe (last verified
backup), devices synced (per-device last activity), backups healthy
(freshness), safe to add a device (server config check green). Vault detail,
device list, events feed. Human-readable warnings only.

## M9: Restore (done)
Restore-to-new-DB + preview; destructive swap with lock + pre-swap snapshot
+ confirm-token; vault lock/unlock endpoints and UI (emergency brake).

## M10: Adopt existing vault + credential rotation polish (done)
Connect an existing LiveSync CouchDB database without mutating it; the vault
detail surfaces legacy (unmanaged) `_security` members and the guided
migration removes them once each device has per-device credentials.
Reinvite already rotates device passwords (M6).

## Optional E2EE (added post-M8)
A vault may be created or adopted unencrypted (`encrypt:false`, no path
obfuscation) for setups where CouchDB is inside the trust boundary. Default
stays on; not togglable after creation. See SECURITY.md.

## M11: Packaging & release (done)
Compose file (app + CouchDB + optional Caddy proxy, persisted CouchDB
`local.d` so config fixes stick); DEPLOYMENT.md walkthroughs (compose
quickstart, docker run, K8s essentials); backup-the-app-itself
documentation; docs/RELEASING.md turns the AGENTS.md Release Readiness
criteria into an executable checklist plus the GitHub publication steps.

## Later (designed-for, not built)
Filesystem/S3/restic backup targets; zero-knowledge mode (unstored E2EE
passphrase); Prometheus metrics endpoint; push notifications; multi-server.
