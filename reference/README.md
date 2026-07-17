# reference/

Vendored verbatim from [vrtmrz/obsidian-livesync](https://github.com/vrtmrz/obsidian-livesync)
(MIT licensed, © vorotamoroz):

- `generate_setupuri.ts` (`utils/flyio/generate_setupuri.ts`): the canonical
  settings payload and `octagonal-wheels` encryption call behind
  `obsidian://setuplivesync` URIs.
- `couchdb-init.sh` (`utils/couchdb/couchdb-init.sh`): the canonical CouchDB
  server configuration for LiveSync.

These files are documentation, not runtime code. Do not import them; port
their behavior per `docs/LIVESYNC_INTEGRATION.md`, and re-check them against
upstream when bumping the supported plugin version range.
