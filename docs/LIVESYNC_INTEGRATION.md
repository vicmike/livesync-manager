# LIVESYNC_INTEGRATION.md

The load-bearing facts about Self-hosted LiveSync and CouchDB that this app
depends on. Sources: vrtmrz/obsidian-livesync (docs, `utils/flyio/
generate_setupuri.ts`, `utils/couchdb/couchdb-init.sh`, vendored under
`reference/`). Verify against upstream when bumping supported plugin versions.

## 1. Setup URI format

A setup URI is `obsidian://setuplivesync?settings=<payload>` where payload is
`encodeURIComponent(encrypt(JSON.stringify(conf), uriPassphrase, false))`
using `encrypt` from `octagonal-wheels/encryption/encryption`, the exact
library the plugin uses for decryption. Upstream pins `octagonal-wheels@0.1.30`
in the Deno script; we depend on the npm package and must keep our pinned
version decrypt-compatible with the plugin versions we support (add a round-
trip test that decrypts our output with the plugin-vendored decrypt).

The upstream reference config (`generate_setupuri.ts`) sets, notably:

```jsonc
{
  "couchDB_URI": "...",        // https URL devices use (COUCHDB_PUBLIC_URL,
                               //   DEPLOYMENT.md), no trailing /db
  "couchDB_USER": "...",       // per-device user in our design
  "couchDB_PASSWORD": "...",
  "couchDB_DBNAME": "...",
  "encrypt": true,
  "passphrase": "...",         // the vault E2EE passphrase
  "usePathObfuscation": true,
  "syncOnStart": true,
  "gcDelay": 0,
  "periodicReplication": true,
  "syncOnFileOpen": true,
  "batchSave": true,
  "batch_size": 50, "batches_limit": 50,
  "useHistory": true,
  "disableRequestURI": true,
  "customChunkSize": 50,
  "syncAfterMerge": false,
  "concurrencyOfReadChunksOnline": 100,
  "minimumIntervalOfReadChunksOnline": 100,
  "handleFilenameCaseSensitive": false,
  "doNotUseFixedRevisionForChunks": false,
  "settingVersion": 10,
  "notifyThresholdOfRemoteStorageSize": 800
}
```

Store this as the per-vault `settings_json` template at vault creation; per-
device invites override only the credential fields. All devices of a vault
must share the chunking-related "tweak values". Since plugin v0.23+ these
are also mirrored into the remote DB, and clients show a Configuration
Mismatch dialog if they drift; keeping one template per vault avoids
triggering it.

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

1. `PUT /vault-<slug>` (admin).
2. Per device: create `org.couchdb.user:<username>` doc in `_users` with
   `{"type":"user","name":...,"password":...,"roles":[]}`.
3. `PUT /vault-<slug>/_security` with all of the vault's active device users
   listed in `members.names`; `admins` empty (server admins retain access
   implicitly). Revocation/rotation rewrites this object plus the `_users`
   doc.

Locking a vault (emergency brake, mirrors LiveSync's "lock remote database"
recovery guidance): swap `_security.members` to an empty sentinel role so no
device can read/write, while the app admin can still operate.

## 4. Device onboarding flow (what the user experiences)

1. Dashboard → vault → "Add device" → name it → invite URL/QR appears.
2. New device: install Obsidian + Self-hosted LiveSync in an **empty vault**,
   open the invite page, tap the deep link (or scan QR on another screen),
   plugin opens "Use the copied setup URI", user enters the invite passphrase
   shown on the page.
3. Plugin asks: import conf? → yes; choose **"Set it up as secondary or
   subsequent device"** (recent plugin versions then run the simplified
   Fast Setup fetch).
4. Vault downloads. Device flips pending → active when we first observe its
   credentials authenticate (or the user hits "I've imported it").

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
- Verify: compare `doc_count` and `update_seq` progress; fetch N random ids
  from both and compare revs.
- Filesystem export (later milestone): stream `_all_docs?include_docs=true&
  attachments=true` to a compressed archive; restore streams back via
  `_bulk_docs` with `new_edits:false` to preserve revision history.
- Restore is always to a new DB first (`-restored-<ts>`); destructive swap is
  a separate, confirm-token operation that locks the original DB first.
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

- Plugin: github.com/vrtmrz/obsidian-livesync (docs/quick_setup.md, docs on
  secondary-device setup)
- `reference/generate_setupuri.ts`: canonical settings payload + encryption
- `reference/couchdb-init.sh`: canonical server settings
- octagonal-wheels on npm (encryption module used by the plugin)
