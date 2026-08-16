# CLAUDE.md

Working title: **LiveSync Manager**, a self-hosted management/control plane for
Obsidian Self-hosted LiveSync + CouchDB. It provisions and manages the
infrastructure; it never touches note content and never replaces LiveSync.

## Read these first, in order

1. `SPEC.md`: product requirements (what to build)
2. `AGENTS.md`: philosophy, safety rules, definition of done (how to behave)
3. `docs/ARCHITECTURE.md`: stack decisions, module layout, data model
4. `docs/API.md`: REST surface for v1
5. `docs/SECURITY.md`: threat model and key-handling decisions (binding)
6. `docs/LIVESYNC_INTEGRATION.md`: the load-bearing facts about LiveSync/CouchDB
7. `docs/DEPLOYMENT.md`: binding runtime contract + Docker/K8s deployment
8. `docs/MILESTONES.md`: PR-sized implementation plan; work top to bottom

`reference/` contains vendored upstream scripts (`generate_setup_uri.ts`,
`provision.ts`) from vrtmrz/obsidian-livesync. They are documentation, not
runtime code; do not import them; port their behavior per
`docs/LIVESYNC_INTEGRATION.md`.

## Stack (decided; do not relitigate without asking)

- Node.js 22 LTS, TypeScript (strict), ESM
- Fastify for the API; Zod for validation at every boundary
- SQLite via better-sqlite3 for app metadata; plain-SQL migrations in `migrations/`
- CouchDB accessed via plain `fetch` wrappers (no nano); one thin client module
- `octagonal-wheels` (npm) for setup-URI encryption, the same library the LiveSync
  plugin uses; pin the version and never hand-roll this crypto
- React + Vite SPA in `web/`, served statically by the API in production
- Vitest for tests; CouchDB integration tests run against a Docker container

## Commands

(Keep this section current.)

```
npm run dev        # API with watch + Vite dev server
npm run test       # vitest
npm run test:integration  # uses throwaway lsc-int-* dbs on the CouchDB at
                          #   COUCHDB_TEST_URL (default localhost:5984; start one with
                          #   docker compose -f dev/couchdb.yml up, or dev/couchdb-k8s.sh).
                          #   Add COUCHDB_TEST_ALLOW_CONFIG_MUTATION=1 on disposable
                          #   instances to include the server-config fix tests.
npm run typecheck  # tsc --noEmit, includes tests
npm run lint       # eslint + prettier check
npm run build      # compile API + build SPA
```

## Conventions

- PR-sized, incremental changes; one milestone step per PR; signed commits.
- Every mutating API endpoint writes an `events` audit row. No silent operations.
- Human-readable log/event messages ("Created vault Personal"), never raw
  status codes as messages.
- Business logic lives in service modules (`src/services/*`), thin route
  handlers, no logic in the SPA beyond presentation.
- All times UTC in storage, ISO 8601 over the wire.
- Errors returned to the UI must be actionable: say what the user can do.

## Safety rules (hard, from AGENTS.md; enforce in code, not just UI)

- Never overwrite an existing vault, delete a CouchDB database, rotate the E2EE
  passphrase, or change replication settings without an explicit confirmation
  token flow (see `docs/API.md` § Destructive operations).
- Vault deletion always offers (and defaults to) a backup first.
- Onboarding links are single-use and expire; tokens are stored hashed.
- The E2EE passphrase is generated once at vault creation and never changes
  through this app in v1 (rotation requires a LiveSync client-side rebuild,
  out of scope; see SECURITY.md).
- Never log secrets: no passphrases, passwords, session tokens, or setup URIs
  in logs or events. Event details reference IDs, not secrets.

## Things that will bite you (see LIVESYNC_INTEGRATION.md for detail)

- CouchDB per-node config endpoints need the node name; discover it via
  `GET /_membership`, don't hardcode `_local`. CORS origins must include
  `app://obsidian.md` and `capacitor://localhost` or mobile clients silently
  fail.
- Runtime CouchDB config writes may not persist (declaratively managed
  `local.ini`, e.g. ConfigMap-fed installs). Verify, don't assume; warn after
  one-click fixes. See LIVESYNC_INTEGRATION.md § 2.
- The app's CouchDB URL and the devices' CouchDB URL are different config
  values (`COUCHDB_ADMIN_URL` vs `COUCHDB_PUBLIC_URL`). Only the public one
  goes into setup URIs. See DEPLOYMENT.md.
- The setup URI passphrase and the vault E2EE passphrase are different secrets.
  Do not conflate them in naming, storage, or UI copy.
- A new device joining with a non-empty vault merges vaults; the onboarding
  page must warn about this loudly.
- Device "last seen" comes from LiveSync's own docs inside the vault database
  (obfuscated IDs; treat heuristically), not from anything we control.
