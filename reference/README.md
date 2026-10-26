# reference/

Vendored verbatim from [vrtmrz/obsidian-livesync](https://github.com/vrtmrz/obsidian-livesync)
(MIT licensed, © vorotamoroz), as of plugin 1.0.39 (2026-10-20); both files are unchanged in 1.0.40:

- `generate_setup_uri.ts` (`utils/setup/generate_setup_uri.ts`): the canonical
  settings payload behind `obsidian://setuplivesync` URIs. Since plugin 1.0 it
  builds settings from `@vrtmrz/livesync-commonlib` (`createNewVaultSettings`,
  `PREFERRED_SETTING_SELF_HOSTED`). Since 1.0.33 it encrypts with
  `encodeTimeBoundSetupURI` (default `uri_mode=ephemeral`: a seven-day
  time-bound HKDF payload; `persistent` is the plain HKDF format) and, by
  default (`id_mode=random`), mints a per-vault independent ID derivation key
  (`idDerivationVersion: 1`, `idDerivationKey`) that it prints as an
  `sls-id-v1:` recovery code. The decoder keeps a fallback to the legacy
  `octagonal-wheels` `encrypt`/`decrypt` format this app emits, and treats a
  URI without the ID-derivation fields as legacy (version 0) IDs — see
  `docs/LIVESYNC_INTEGRATION.md` § 1 for what we adopt and what we omit.
- `provision.ts` (`utils/couchdb/provision.ts`): the canonical CouchDB server
  configuration for LiveSync. Unchanged between 1.0.18 and 1.0.39. Replaces
  the old `couchdb-init.sh` curl loop (same nine config keys) and additionally
  creates the database and stamps the `obsydian_livesync_version` marker via
  commonlib's `checkRemoteVersion`.

The pre-1.0 files these replaced (`utils/flyio/generate_setupuri.ts`,
`utils/couchdb/couchdb-init.sh`) still exist upstream but are now thin
wrappers around the two files above.

These files are documentation, not runtime code. Do not import them; port
their behavior per `docs/LIVESYNC_INTEGRATION.md`, and re-check them against
upstream when bumping the supported plugin version range (record the result
in the "Reviewed against" line of `docs/LIVESYNC_INTEGRATION.md`).
