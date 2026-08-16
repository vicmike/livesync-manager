// LiveSync stores replication-critical state in CouchDB _local documents,
// which one-shot replication and _all_docs both skip. The load-bearing one is
// _local/obsidian_livesync_sync_parameters: it holds the pbkdf2salt for E2EE
// v2 (HKDF). A snapshot without it is undecryptable even with the correct
// passphrase, because a reconnecting device would mint a fresh salt
// (LIVESYNC_INTEGRATION.md § 6; upstream issue #1040 shows the failure mode).

// The milestone/nodeinfo docs use upstream's historical "obsydian" spelling;
// sync_parameters does not. Match both.
export const LIVESYNC_LOCAL_DOC_PREFIXES = ['_local/obsidian_livesync', '_local/obsydian_livesync'];

export const SYNC_PARAMETERS_DOC_ID = '_local/obsidian_livesync_sync_parameters';

// The CouchDB operations local-doc copying needs; satisfied by CouchClient.
export interface LocalDocsCouch {
  listLocalDocs(db: string): Promise<string[]>;
  getLocalDoc(db: string, id: string): Promise<Record<string, unknown> & { _rev: string }>;
  putLocalDoc(db: string, id: string, doc: Record<string, unknown>): Promise<void>;
}

/**
 * Copies LiveSync's own _local documents from one database to another.
 * Only LiveSync-prefixed docs are copied: other _local docs are replication
 * checkpoints, and cloning those into a rebuilt database could make a
 * replicator trust sequence numbers the new database never issued.
 * Returns the ids that were copied.
 */
export async function copyLiveSyncLocalDocs(
  couch: LocalDocsCouch,
  source: string,
  target: string,
): Promise<string[]> {
  const ids = (await couch.listLocalDocs(source)).filter((id) =>
    LIVESYNC_LOCAL_DOC_PREFIXES.some((prefix) => id.startsWith(prefix)),
  );
  for (const id of ids) {
    const doc = await couch.getLocalDoc(source, id);
    await couch.putLocalDoc(target, id, doc);
  }
  return ids;
}
