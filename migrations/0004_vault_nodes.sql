-- LiveSync client observations, projected from each vault's
-- _local/obsydian_livesync_milestone document (docs/LIVESYNC_INTEGRATION.md
-- § 5). Refreshed on every read; the document itself is never written by us.
-- node_id is LiveSync's random per-install id, not a CouchDB user.

CREATE TABLE vault_nodes (
  vault_id        TEXT NOT NULL REFERENCES vaults(id),
  node_id         TEXT NOT NULL,
  device_name     TEXT,                      -- LiveSync's own device-and-vault name setting
  vault_name      TEXT,                      -- the Obsidian vault folder name
  plugin_version  TEXT,
  app_version     TEXT,                      -- Obsidian version
  platform        TEXT,                      -- only reported by newer plugins
  accepted        INTEGER NOT NULL DEFAULT 1,-- still listed in accepted_nodes
  last_connected  TEXT,                      -- ISO, from node_info.last_connected
  first_seen      TEXT NOT NULL,             -- when this app first observed the node
  last_observed   TEXT NOT NULL,             -- when this app last saw it in the document
  PRIMARY KEY (vault_id, node_id)
);

-- A LiveSync client is linked to at most one managed device per vault.
-- (SQLite unique indexes allow any number of NULLs.)
CREATE UNIQUE INDEX idx_devices_vault_node ON devices(vault_id, livesync_node_id);
