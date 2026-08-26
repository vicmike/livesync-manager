# reference/

Vendored verbatim from [vrtmrz/obsidian-livesync](https://github.com/vrtmrz/obsidian-livesync)
(MIT licensed, © vorotamoroz), as of plugin 1.0.18 (2026-08-25):

- `generate_setup_uri.ts` (`utils/setup/generate_setup_uri.ts`): the canonical
  settings payload behind `obsidian://setuplivesync` URIs. Since plugin 1.0 it
  builds settings from `@vrtmrz/livesync-commonlib` (`createNewVaultSettings`,
  `PREFERRED_SETTING_SELF_HOSTED`) and encrypts with
  `encodeSettingsToSetupURI` (HKDF ephemeral-salt format; the decoder keeps a
  fallback to the legacy `octagonal-wheels` `encrypt`/`decrypt` format this
  app emits — see `docs/LIVESYNC_INTEGRATION.md` § 1).
- `provision.ts` (`utils/couchdb/provision.ts`): the canonical CouchDB server
  configuration for LiveSync. Replaces the old `couchdb-init.sh` curl loop
  (same nine config keys) and additionally creates the database and stamps the
  `obsydian_livesync_version` marker via commonlib's `checkRemoteVersion`.

The pre-1.0 files these replaced (`utils/flyio/generate_setupuri.ts`,
`utils/couchdb/couchdb-init.sh`) still exist upstream but are now thin
wrappers around the two files above.

These files are documentation, not runtime code. Do not import them; port
their behavior per `docs/LIVESYNC_INTEGRATION.md`, and re-check them against
upstream when bumping the supported plugin version range (record the result
in the "Verified against" line of `docs/LIVESYNC_INTEGRATION.md`).
