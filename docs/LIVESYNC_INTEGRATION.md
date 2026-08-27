# LIVESYNC_INTEGRATION.md

The load-bearing facts about Self-hosted LiveSync and CouchDB that this app
depends on. Sources: vrtmrz/obsidian-livesync (docs,
`utils/setup/generate_setup_uri.ts`, `utils/couchdb/provision.ts`, vendored
under `reference/`) and `@vrtmrz/livesync-commonlib` on npm (the plugin's own
shared library, published since 1.0). Verify against upstream when bumping
supported plugin versions and update the line below.

**Reviewed against: plugin 1.0.21, `@vrtmrz/livesync-commonlib` 0.1.19,
`octagonal-wheels` 0.1.53 — 2026-08-26. A real-device onboarding smoke test
remains a release gate.**

## 1. Setup URI format

A setup URI is `obsidian://setuplivesync?settings=<payload>`. This app emits
the legacy payload format:
`encodeURIComponent(encrypt(JSON.stringify(conf), uriPassphrase, false))`
using `encrypt` from `octagonal-wheels/encryption/encryption` (`%`-prefixed
AES-256-GCM). The plugin's own generator switched in 1.0 to an HKDF
ephemeral-salt format (`%$` prefix, `encryptWithEphemeralSalt`), but its
decoder — commonlib `decodeSettingsFromSetupURI` → `decryptString` —
explicitly falls back to the legacy `decrypt(payload, passphrase, false)` /
`(…, true)`, so every plugin version decodes our URIs, while pre-HKDF plugin
versions could not decode the new format. Revisit if upstream ever deprecates
that fallback. `src/crypto/setupUri.test.ts` round-trips our output through
`@vrtmrz/livesync-commonlib` — the exact code a device runs — which is the
compatibility proof this document requires.

Settings payloads with flat `couchDB_*` fields remain the compatibility path
in 1.0: the plugin migrates them into a `legacy-*` "remote configuration
profile" on import. The multi-remote profile map (`remoteConfigurations`,
`activeConfigurationId`) is out of scope for this app while CouchDB is the
only supported remote.

`isConfigured: true` is required. Without it, the plugin can import and
decrypt the URI but returns to its first-run setup screen after the required
restart. The invite test asserts that this and the connection, encryption,
and sync-trigger fields survive URI generation.

The upstream reference config (commonlib `PREFERRED_SETTING_SELF_HOSTED` plus
the behavior flags upstream's `utils/setup/generate_setup_uri.ts` sets):

```jsonc
{
  "couchDB_URI": "...",        // https URL devices use (COUCHDB_PUBLIC_URL,
                               //   DEPLOYMENT.md), no trailing /db
  "couchDB_USER": "...",       // per-device user in our design
  "couchDB_PASSWORD": "...",
  "couchDB_DBNAME": "...",
  "isConfigured": true,       // required after setup-URI import
  "encrypt": true,
  "passphrase": "...",         // the vault E2EE passphrase
  "usePathObfuscation": true,
  "E2EEAlgorithm": "v2",       // HKDF; the plugin default since 0.25.x
  "syncOnStart": true,
  "periodicReplication": true,
  "syncOnFileOpen": true,
  "batchSave": true,
  "batch_size": 50, "batches_limit": 50,
  "useHistory": true,
  "disableRequestURI": true,
  "syncAfterMerge": false,
  "syncMaxSizeInMB": 50,
  "chunkSplitterVersion": "v3-rabin-karp",
  "usePluginSyncV2": true,
  "customChunkSize": 60,
  "sendChunksBulkMaxSize": 1,
  "concurrencyOfReadChunksOnline": 30,
  "minimumIntervalOfReadChunksOnline": 25,
  "handleFilenameCaseSensitive": false,
  "settingVersion": 10,
  "notifyThresholdOfRemoteStorageSize": 800
}
```

Do not set `doNotUseFixedRevisionForChunks` or `gcDelay`: the former's UI
control was removed in plugin 1.0 and upstream's generator explicitly erases
it from URIs; the latter was a stale flyio-script value fighting the plugin
default.

Store this as the per-vault `settings_json` template at vault creation; per-
device invites override only the credential fields. All devices of a vault
must share the chunking-related "tweak values". Since plugin v0.23+ these
are also mirrored into the remote DB, and clients show a Configuration
Mismatch dialog if they drift; keeping one template per vault avoids
triggering it. Plugin 1.0 additionally auto-aligns "compatible" differences
(chunk hash algorithm, chunk size, splitter version) by default, and joining
devices that answer "Yes, fetch" during setup adopt the vault's stored
tweaks, so template evolution does not strand existing vaults.

`settingVersion` matters: bump-testing against new plugin releases is a
maintenance task. Treat "supported plugin version range" as a documented,
tested property of each release of this app.

## 2. Required CouchDB server configuration

From `couchdb-init.sh`, applied via `PUT /_node/<node>/_config/...`. Discover
the node name from `GET /_membership` (first entry of `all_nodes`) rather
than hardcoding `_local`. `_local` works on single-node installs but not on
clusters or installs with an explicit node name:

| Section/key | Value |
|---|---|
| `chttpd/require_valid_user` | `true` |
| `chttpd_auth/require_valid_user` | `true` |
| `httpd/WWW-Authenticate` | `Basic realm="couchdb"` |
| `httpd/enable_cors`, `chttpd/enable_cors` | `true` |
| `chttpd/max_http_request_size` | `4294967296` |
| `couchdb/max_document_size` | `50000000` |
| `cors/credentials` | `true` |
| `cors/origins` | `app://obsidian.md,capacitor://localhost,http://localhost` |

The app's "Check server configuration" health item verifies these and offers
a one-click fix (idempotent PUTs). Missing CORS origins is the classic
"works on desktop, silently fails on iOS/Android" failure.

**Runtime config writes may not persist.** `PUT /_node/<node>/_config/...`
writes to the last `.ini` file in CouchDB's chain, but many deployments
manage that file declaratively (Kubernetes ConfigMap copied into an emptyDir
`local.d` by an init container; Docker images with a baked-in `local.ini`).
There, a one-click fix succeeds, verifies green, and silently reverts on the
next CouchDB restart. So: always verify rather than assume; after applying a
fix, tell the user the settings may be managed declaratively and should be
mirrored into their deployment's config source; and treat the check as the
source of truth, re-running it after CouchDB restarts. Verification passing
now ≠ fix persisted.

## 3. Vault database provisioning

Per vault:

1. `PUT /vault-<slug>` (admin), then stamp
   `{"_id":"obsydian_livesync_version","version":12,"type":"versioninfo"}`
   ("obsydian" is upstream's spelling; `VER = 12` in commonlib). Upstream's
   `provision.ts` does the same; plugin 1.0.6+ uses it to distinguish an
   empty-but-valid remote from a failed read.
2. Per device: create `org.couchdb.user:<username>` doc in `_users` with
   `{"type":"user","name":...,"password":...,"roles":[]}`.
3. `PUT /vault-<slug>/_security` with all of the vault's active device users
   listed in `members.names`; `admins` empty (server admins retain access
   implicitly). Revocation/rotation rewrites this object plus the `_users`
   doc.

Locking a vault (emergency brake, mirrors LiveSync's "lock remote database"
recovery guidance): swap `_security.members` to an empty sentinel role so no
device can read/write, while the app admin can still operate.

## 4. Device onboarding flow (what the user experiences, plugin 1.0.13+)

1. Dashboard → vault → "Add device" → name it → invite URL/QR appears.
2. New device: install Obsidian + Self-hosted LiveSync in an **empty vault**,
   open the invite page, tap the deep link (or scan QR on another screen; or
   choose **"Connect with Setup URI"** in the plugin's setup notice and paste
   the URI), enter the invite passphrase shown on the page.
3. The 1.0 setup wizard then asks, in order:
   - **"Fetch configuration from remote database?"** — joining devices answer
     *"Yes, please fetch the configuration"* (adopts the vault's stored tweak
     values); the very first device answers *"No, please use the settings in
     the URI"*.
   - **"Do you want to consult the doctor?"** — *"No, please use the settings
     in the URI as is"* (our template is current).
   - **"Apply new configuration"** — **"Apply and Fetch"** for a new/empty
     device. *"Apply and Merge"* is only for a device that already holds the
     vault's files; *"Apply and Rebuild"* overwrites the server for every
     other device and must never be chosen while joining.
4. Vault downloads. Device flips pending → active when we first observe its
   credentials authenticate (or the user hits "I've imported it").

Device accounts are deliberately not CouchDB server administrators. LiveSync's
optional server requirements check may report forbidden access when run with a
device account; ordinary vault replication is unaffected. The manager performs
server health checks with its separate CouchDB administrator account.

The invite page must state, unmissably: *if this device's vault is not empty,
LiveSync will merge the two vaults. This is very hard to undo.* This single
warning prevents the most common catastrophic user error.

## 5. Device activity inference

LiveSync keeps internal documents (milestone / node info) in the vault DB and
tracks per-device sync state there. IDs are internal and, with path
obfuscation, most content docs are opaque (good); we never read note content.
Last-seen strategy, in order of preference:

1. CouchDB `_session`/access observations per device user where the server
   exposes them (or proxy access logs, if configured; optional).
2. Heuristic: changes feed activity following an invite consumption maps the
   new LiveSync node to the pending device.

Present as "last activity (approximate)". Do not build features that require
this to be exact.

## 6. Backup and restore mechanics

- Snapshot: `POST /_replicate {"source":"vault-x","target":"bk-vault-x-<ts>",
  "create_target":true}` (one-shot). Poll `_active_tasks`/completion.
- **Copy LiveSync's `_local` documents explicitly.** Replication and
  `_all_docs` both skip `_local/*` docs, and LiveSync's E2EE v2 (HKDF, the
  default algorithm) stores its `pbkdf2salt` in
  `_local/obsidian_livesync_sync_parameters`. A snapshot without that doc is
  undecryptable **even with the correct passphrase**: a device reconnecting
  to the restored database mints a fresh salt, and every pre-restore chunk
  fails with "Decryption with HKDF failed" (upstream issue #1040 shows the
  symptom). So after every replication-based copy, list `GET /db/_local_docs`
  and re-PUT the `_local/obsidian_livesync*` / `_local/obsydian_livesync*`
  docs (`sync_parameters`, `milestone`, `nodeinfo` — the latter two use
  upstream's historical "obsydian" spelling) into the target. Do **not** copy
  other `_local` docs: they are replication checkpoints, and cloning them
  into a rebuilt database could make a replicator trust sequence numbers the
  new database never issued (`src/services/localDocs.ts`).
- Verify: compare `doc_count` and `update_seq` progress; fetch N random ids
  from both and compare revs.
- Filesystem export (later milestone): stream `_all_docs?include_docs=true&
  attachments=true` to a compressed archive **plus the `_local` LiveSync docs
  above** (they are absent from `_all_docs`); restore streams back via
  `_bulk_docs` with `new_edits:false` to preserve revision history, then
  re-PUTs the `_local` docs.
- Restore is always to a new DB first (`-restored-<ts>`); destructive swap is
  a separate, confirm-token operation that locks the original DB first. Stop
  LiveSync on every device before the swap, then have every device fetch from
  the restored server state afterward.
- Note: E2EE means backups are encrypted blobs without the vault passphrase,
  another reason the passphrase must live in the admin's password manager,
  not only in this app.

## 7. Operations this app cannot do (client-side only)

- Rebuild database / fetch-everything resets: must run in a LiveSync client.
  The app's role during recovery is: lock DB, guide the user, unlock.
- E2EE passphrase rotation: requires client-side re-encryption/rebuild.
  Out of scope for v1 (SECURITY.md).
- Conflict resolution: explicitly a non-goal (SPEC.md).

## 8. Upstream references

- Plugin: github.com/vrtmrz/obsidian-livesync (docs/quick_setup.md; the
  English message catalog `src/common/messagesJson/en.json` is the source of
  truth for dialog wording quoted in § 4 and on the invite page)
- `@vrtmrz/livesync-commonlib` on npm: the plugin's shared library
  (setup-URI encode/decode, `PREFERRED_SETTING_SELF_HOSTED`,
  `CURRENT_SETTING_VERSION`, `_local` doc ids); dev-dependency here for the
  round-trip test
- `reference/generate_setup_uri.ts` (`utils/setup/generate_setup_uri.ts`):
  canonical settings payload + encryption entry point
- `reference/provision.ts` (`utils/couchdb/provision.ts`): canonical server
  settings + database provisioning
- octagonal-wheels on npm (encryption module used by the plugin and by us;
  keep our pin ≥ the version commonlib requires)
