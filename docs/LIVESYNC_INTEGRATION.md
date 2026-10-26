# LIVESYNC_INTEGRATION.md

The load-bearing facts about Self-hosted LiveSync and CouchDB that this app
depends on. Sources: vrtmrz/obsidian-livesync (docs,
`utils/setup/generate_setup_uri.ts`, `utils/couchdb/provision.ts`, vendored
under `reference/`) and `@vrtmrz/livesync-commonlib` on npm (the plugin's own
shared library, published since 1.0). Verify against upstream when bumping
supported plugin versions and update the line below.

**Reviewed against: plugin 1.0.40, `@vrtmrz/livesync-commonlib` 0.2.0 (the
version 1.0.40 ships; its setup-URI codec and remote-version check are
identical to 0.1.44), `octagonal-wheels` 0.1.55 — 2026-10-26. A real-device
onboarding smoke test remains a release gate.**

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

Plugin 1.0.33 added **time-bound** setup URIs (`encodeTimeBoundSetupURI`,
mode `ephemeral`): the payload is encrypted under an HMAC of the passphrase
and the current fixed seven-day UTC window, so the URI stops opening when the
window ends. Upstream's generator defaults to it; its `persistent` mode is
the plain HKDF format above. We deliberately stay on the legacy format: the
time condition is only enforced by 1.0.33+ clients and does not revoke
credentials, whereas our invites are single-use and expire server-side
(SECURITY.md § Invite links), which is strictly stronger.

Setup URIs carry both the compatibility `couchDB_*` fields and an explicit,
active CouchDB profile in `remoteConfigurations`. The plugin still migrates a
flat-only payload into a `legacy-*` profile, but that is a compatibility path,
not the supported new-device setup flow. Each device's profile has the same
stable identity and name but its own CouchDB credentials.

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
  "remoteConfigurations": { "livesync-manager-couchdb": { "...": "..." } },
  "activeConfigurationId": "livesync-manager-couchdb",
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
  "customChunkSize": 0,
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

**Settings introduced in plugin 1.0.33–1.0.38, and what we do with them.**
The decoder and the plugin's `SetupManager` fill the defaults when a URI
lacks them, so omission means explicit "legacy", not "unspecified"
(`src/crypto/setupUri.test.ts` pins both the legacy and the keyed case):

- `idDerivationVersion` / `idDerivationKey` (1.0.33, "independent ID
  derivation"): a per-vault random 256-bit key from which chunk IDs and
  obfuscated metadata IDs are derived, instead of from the E2EE passphrase.
  The plugin's own wizard turns it on for new vaults and reveals the key as
  an `sls-id-v1:<64 hex>` recovery code. Every device of a vault must carry
  the same key; the milestone tweak check hard-fails (`ID_KEY_MISMATCH`) on a
  difference, and changing it needs the usual rebuild + fetch.
  **Adopted for new encrypted vaults** (`vaults.id_derivation_key_enc`): the
  key is generated at creation, shown once as the ID recovery code next to
  the passphrase, stored encrypted like the passphrase, and merged into every
  invite together with `idDerivationVersion: 1` (the decoder rejects a key
  without its version). Unencrypted vaults, vaults created before this, and
  adopted databases without a recovery code stay on version 0 (passphrase-
  derived IDs); `POST /vaults/connect` accepts `idRecoveryCode` for an
  existing keyed vault. A keyed vault needs plugin ≥ 1.0.33 on every device:
  older clients ignore the fields and would write legacy IDs, and the remote
  feature generation in § 3 is what stops them. The invite page and the SPA
  state the floor per vault (`minimumPluginVersion`).
- `encryptInternalMetadata` (1.0.33, "Encrypt internal file Properties"):
  extends E2EE to the paths, times, sizes and chunk references of hidden-file
  and customisation-sync documents. Needs `encrypt`, `usePathObfuscation` and
  `E2EEAlgorithm: "v2"`, which our encrypted template has. **Enabled for new
  encrypted vaults** (same ≥ 1.0.33 floor); left off for adopted vaults,
  as upstream does for existing configurations, because turning it on later
  needs every device updated and a rebuild.
- `pathNormalizationVersion` (1.0.38, NFC path identity): opt-in, needs a
  rebuild to change, unsupported by P2P and object storage. Omitted.

`customChunkSize: 0` follows plugin 1.0.40 (commonlib 0.2.0), which made 0
the recommendation for every remote type with the V3 Rabin–Karp splitter and
stopped Setting Doctor from recommending 60 for self-hosted vaults. Vaults
created before app 0.4.2 keep the 60 stored in their template; it is a
"compatible, lossy" tweak, joining devices adopt the vault's stored value, and
upstream keeps existing explicit values, so nothing needs to change for them.

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

| Section/key | Requirement | Applies to |
|---|---|---|
| `chttpd/require_valid_user` | `true` | CouchDB ≥ 3.2 |
| `chttpd_auth/require_valid_user` | `true` | CouchDB < 3.2 (ignored by 3.2+; reported as informational if still set) |
| `httpd/WWW-Authenticate` | `Basic realm="couchdb"` | all |
| `chttpd/enable_cors` | `true` | CouchDB ≥ 3.2 |
| `httpd/enable_cors` | `true` | CouchDB < 3.2 (ignored by 3.2+; informational) |
| `chttpd/max_http_request_size` | at least `4294967296` | all |
| `couchdb/max_document_size` | at least `50000000` | all |
| `cors/credentials` | `true` | all |
| `cors/origins` | includes `app://obsidian.md`, `capacitor://localhost`, `http://localhost`; a bare `*` also passes | all |

These are the plugin's own rules ("Check database configuration",
`utilCheckCouchDB.ts`): CouchDB 3.2 moved the authentication and CORS
switches to the `chttpd` section, the two size limits are minimums, and a
wildcard origin is accepted. The app's "Check server configuration" health
item applies the same rules, picking the key set from the server version
(unknown version ⇒ modern keys), and offers a one-click fix that writes the
exact values above (idempotent PUTs). Demanding the legacy keys on a 3.2+
server was a false positive that upstream fixed in the plugin too (its
reference `local.ini` sets only the modern keys). Missing CORS origins is the
classic "works on desktop, silently fails on iOS/Android" failure.

**The config check cannot see the devices' path.** It reads CouchDB's
settings over `COUCHDB_ADMIN_URL`; devices use `COUCHDB_PUBLIC_URL`, usually
through a reverse proxy, and the dominant upstream support theme is a proxy
that redirects (a redirect loop drops the CORS headers), adds or strips CORS
headers, or serves a certificate mobile OSes do not trust. So the health
monitor also probes `COUCHDB_PUBLIC_URL/` from the manager once per required
origin, as the plugin does: no credentials, redirects not followed, and the
response must echo the origin in `Access-Control-Allow-Origin` and carry
`Access-Control-Allow-Credentials: true`. Any 3xx or 5xx, a missing or
mismatched allow-origin, missing allow-credentials, or a network/TLS error is
reported per origin with what to change; a plain-`http` URL is a warning
(mobile Obsidian requires OS-trusted https). The probe is a separate health
item from the config check so one failing never hides the other.

One case is reported as *inconclusive* (a warning, not a failure): HTTP 401
or 403 **without** CORS headers and without a CouchDB `Server` banner.
CouchDB sends its CORS headers even on its own 401, so that response means
an access-control layer in front of it (an IP allowlist on the ingress, a WAF,
an authenticating proxy) refused the manager's own address before CouchDB
saw the request, and nothing can be said about what devices see. The fix is
to allow the manager's egress address through, or to accept the item as
inconclusive while devices sync fine.

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
   Since plugin 1.0.33 this document is also the **remote feature
   negotiation** record: generation 12 without `used_features` means "no
   optional features in use". A client that enables independent ID
   derivation, encrypted internal metadata or NFC path identity bumps it to
   `version: 13` and adds `used_features: [...]`; every 1.0.33+ client then
   refuses a remote whose features it does not know, and pre-1.0.33 clients
   refuse generation 13 outright. Keep stamping 12: it is what old and new
   clients alike accept for a fresh database. Never rewrite this document on
   an adopted or restored database (backups copy it verbatim).
   `src/services/versionMarker.test.ts` runs commonlib's own
   `checkRemoteVersion` against our marker.
2. Per device: create `org.couchdb.user:<username>` doc in `_users` with
   `{"type":"user","name":...,"password":...,"roles":[]}`.
3. `PUT /vault-<slug>/_security` with all of the vault's active device users
   listed in `members.names`; `admins` empty (server admins retain access
   implicitly). Revocation/rotation rewrites this object plus the `_users`
   doc.

Locking a vault (emergency brake, mirrors LiveSync's "lock remote database"
recovery guidance): swap `_security.members` to an empty sentinel role so no
device can read/write, while the app admin can still operate.

## 4. Device onboarding flow (what the user experiences, plugin 1.0.39)

1. Dashboard → vault → "Add device" → name it → invite URL/QR appears.
2. New device: install Obsidian + Self-hosted LiveSync in an **empty vault**,
   open the invite page, tap the deep link (or scan the QR code and open the
   copied link). The link opens the plugin's **"Enter Setup URI"** dialog
   with the URI filled in; the user types the invite passphrase and chooses
   **"Test Settings and Continue"**.
3. The deep link enters the wizard with an unknown user mode
   (`setupProtocol.ts` → `onUseSetupURI(UserMode.Unknown)`), so after the
   test the plugin shows **"Mostly Complete: Decision Required"** with three
   choices: *"⚠️ Initialise or overwrite the remote"* (first device of a
   brand-new vault only; it rebuilds the server from this device), **"🔗 Join
   this device"** (every additional device), *"⚙️ Apply settings only
   (advanced)"* (a device that already holds the vault's data).
4. Joining: **"Setup Complete: Preparing to Fetch Synchronisation Data"** →
   **"Restart and Fetch Data"**. After the restart, Fast Setup
   (`redFlag.simpleFetch.ts`, upstream `tips/fast-setup.md`) asks
   **"Data retrieval scheduled"** → *"Overwrite all with remote files"* for
   an empty vault (*"Compare time and take newer"* is for a vault with local
   work) → *"How to handle extra existing local files?"* → *"Keep local files
   even if not on remote"* (default; either is fine for an empty vault).
   A **"All optional features are disabled"** acknowledgement may follow.
5. Alternative entry when the link does not open the plugin: the **"Welcome
   to Self-hosted LiveSync"** notice → *"I am adding a device to an existing
   synchronisation setup"* → *"Use a Setup URI (Recommended)"* → paste. This
   path knows the user mode and skips step 3, going straight to step 4.
6. Vault downloads. Device flips pending → active when the invite page's
   "I've imported it" button is used, when the admin marks it connected, or
   (§ 5) when a new LiveSync client is attributed to it.

The pre-1.0.3x dialogs ("Fetch configuration from remote database?", "Do you
want to consult the doctor?", "Apply and Fetch") still exist in the message
catalog but are not reachable from the setup-URI path in 1.0.39
(`SetupManager.ts` wires `UseSetupURI → OutroAskUserMode → OutroExistingUser`
only). Do not quote them; when re-verifying wording, check the Svelte dialogs
under `src/modules/features/SetupWizard/dialogs/` and `redFlag.simpleFetch.ts`,
not just `en.json`. Verified against 1.0.39 source on 2026-10-23; a live
device pass remains the release gate.

Device accounts are deliberately not CouchDB server administrators. LiveSync's
optional server requirements check may report forbidden access when run with a
device account; ordinary vault replication is unaffected. The manager performs
server health checks with its separate CouchDB administrator account.

The invite page asks for plugin **1.0.37 or newer** for every vault
(`src/services/pluginVersion.ts`): 1.0.37 fixed a security issue where
synchronised changes could reach files outside the sync scope, and it is above
the 1.0.33 floor that keyed vaults (§ 1) need. The import flow itself works
from 1.0.13.

The invite page must state, unmissably: *if this device's vault is not empty,
LiveSync will merge the two vaults. This is very hard to undo.* This single
warning prevents the most common catastrophic user error.

## 5. Device activity inference

LiveSync keeps its per-device bookkeeping in
`_local/obsydian_livesync_milestone` (`MILESTONE_DOCID` in commonlib; a
`_local` doc, so it is admin-readable and never replicated). Each client
refreshes it when replication opens (`ensureRemoteIsCompatible` in
commonlib's `LiveSyncDBFunctions`). Shape as of commonlib 0.1.44 / 0.2.0:

```jsonc
{
  "type": "milestoneinfo",
  "locked": false, "cleaned": false,
  "accepted_nodes": ["<nodeId>"],            // nodes still allowed after a lock
  "node_chunk_info": { "<nodeId>": { "min": 0, "max": 0 } },
  "node_info": {
    "<nodeId>": {
      "device_name": "...",      // LiveSync's own "device and vault name" setting
      "vault_name": "...",       // the Obsidian vault folder name
      "app_version": "1.11.x",
      "plugin_version": "1.0.39",
      "platform": "ios",         // commonlib 0.2.0+ (plugins after 1.0.39) only
      "last_connected": 1760000000000,  // ms epoch, refreshed at most once a minute
      "progress": "<update_seq>"
    }
  },
  "tweak_values": { "PREFERRED": {}, "<nodeId>": {} }
}
```

`nodeId` is LiveSync's random per-install node id, not our device account;
nothing in the document names the CouchDB user. commonlib 0.2.0 adds
`projectJoinedDevices()` / `forgetJoinedDevice()` over this document (a
"joined devices" view is coming to the plugin), which confirms the shape is
upstream-supported rather than incidental. With path obfuscation, content
docs stay opaque; we never read note content.

Last-seen strategy, in order of preference:

1. `node_info[*].last_connected` from the milestone document, read with the
   admin account. It also carries `plugin_version`, so outdated clients
   (anything below 1.0.37's security fix) can be flagged per vault.
2. Mapping nodes to our devices is heuristic: a node first observed after an
   invite was consumed, with no other new node in the window, belongs to
   that device. Unmapped nodes are still worth showing at vault level.
3. CouchDB `_session`/access observations or proxy access logs, if ever
   configured (optional).

LiveSync never removes a node from this document: every reinstall, wiped
vault or retired device stays listed with its last version. A real vault after
four months held twelve nodes, two of them in use. The manager therefore marks
nodes without a connection for 30 days as *stale*, hides them by default and
leaves them out of the outdated-plugin warning. Plugin 1.0.40's **Review
devices** dialog (command palette, or Remote Configuration) lists the same
records with "this device" first, which is the easiest way to tell which node
is which, and can **forget** retired ones without touching files or
credentials.

`locked: true` is LiveSync's own lock, set by a rebuild ("Overwrite Server
Data"). Devices in `accepted_nodes` keep syncing; any other node (new,
reinstalled, set up again) stops at the plugin's **"Locked"** dialog before it
registers, so it never appears here. Its options, from the 1.0.40 catalog
(`Replicator.Dialogue.Locked.*`): **"Reset Synchronisation on This Device"**
(the right answer for a joining device), *"Unlock the remote database"* (only
on a device known to be fully in sync), *"Cancel for reconfirmation"*. The
vault page shows a notice whenever the lock is set. It is independent of this
app's own vault lock, which edits `_security`.

Present as "last activity (approximate)". Do not build features that require
this to be exact, and never write to this document: a conflicting write
races every client's compatibility check.

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
  LiveSync on every device before the swap. Afterwards every device must run
  **Reset Synchronisation on This Device** (Settings → Maintenance →
  "Rebuilding Operations (Local)"; the file-flag equivalent is an empty
  `flag_fetch.md` in the vault root, picked up on the next start). Never
  **Overwrite Server Data with This Device's Files** after a restore: it
  rebuilds the remote from that one device and locks the others out.
  `DEVICE_RESYNC_INSTRUCTIONS` in `src/services/vaults.ts` carries this
  wording into the swap consequences, the unlock event and the UI.
- Note: E2EE means backups are encrypted blobs without the vault passphrase,
  another reason the passphrase must live in the admin's password manager,
  not only in this app.

## 7. Operations this app cannot do (client-side only)

- Rebuild database / fetch-everything resets: must run in a LiveSync client
  ("Reset Synchronisation on This Device" to adopt the server's copy;
  "Overwrite Server Data with This Device's Files" to replace the server
  from one device; `flag_fetch.md` / `flag_rebuild.md` in the vault root
  schedule the same on next start, upstream `recovery.md`). The app's
  role during recovery is: lock DB, guide the user with the exact menu
  wording, unlock.
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
  setup-URI round-trip and version-marker tests (`compat/API/processSetting`,
  `compat/pouchdb/negotiation`). Pin it to the version the reviewed plugin
  release ships (`package.json` in the plugin repo)
- `reference/generate_setup_uri.ts` (`utils/setup/generate_setup_uri.ts`):
  canonical settings payload + encryption entry point
- `reference/provision.ts` (`utils/couchdb/provision.ts`): canonical server
  settings + database provisioning
- octagonal-wheels on npm (encryption module used by the plugin and by us;
  keep our pin ≥ the version commonlib requires)
