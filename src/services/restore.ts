import { v7 as uuidv7 } from 'uuid';
import type { Config } from '../config/index.js';
import type { AppDatabase } from '../db/index.js';
import type { DatabaseInfo, ReplicationRequest, SecurityObject } from '../couch/client.js';
import { getBackup, type Backup } from './backups.js';
import { recordEvent } from './events.js';
import { copyLiveSyncLocalDocs, type LocalDocsCouch } from './localDocs.js';
import {
  activeDeviceUsernames,
  getVault,
  membersSecurity,
  NO_MEMBERS_SECURITY,
  VaultError,
} from './vaults.js';

// The CouchDB operations restore needs; satisfied by CouchClient.
export interface RestoreCouch extends LocalDocsCouch {
  databaseInfo(name: string): Promise<DatabaseInfo>;
  replicate(request: ReplicationRequest): Promise<{ ok?: boolean }>;
  deleteDatabase(name: string): Promise<void>;
  setSecurity(db: string, security: SecurityObject): Promise<void>;
}

export interface RestoreDeps {
  db: AppDatabase;
  couch: RestoreCouch;
  config: Config;
}

function timestamp(): string {
  return new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
}

function authorityUrl(config: Config, dbName: string): string {
  const url = new URL(config.couchdb.adminUrl);
  url.username = config.couchdb.adminUser;
  url.password = config.couchdb.adminPassword;
  return new URL(dbName, url).href;
}

function usableBackup(deps: RestoreDeps, backupId: string): Backup {
  const backup = getBackup(deps.db, backupId);
  if (backup.status !== 'verified' && backup.status !== 'complete') {
    throw new VaultError(`Backup is ${backup.status}; only finished backups can be restored.`, 409);
  }
  return backup;
}

export interface RestorePreview {
  location: string;
  docCount: number;
  sizeBytes: number;
  restoreTarget: string;
  vaultDbName: string;
}

export async function restorePreview(deps: RestoreDeps, backupId: string): Promise<RestorePreview> {
  const backup = usableBackup(deps, backupId);
  const vault = getVault(deps.db, backup.vaultId);
  const info = await deps.couch.databaseInfo(backup.location);
  return {
    location: backup.location,
    docCount: info.doc_count,
    sizeBytes: info.sizes.file,
    restoreTarget: `${vault.couchDbName}-restored-${timestamp()}`,
    vaultDbName: vault.couchDbName,
  };
}

/**
 * Non-destructive restore: materializes the snapshot as a sibling database.
 * The admin can inspect it, point new invites at it (adopt it as a vault),
 * or run the destructive swap afterwards.
 */
export async function restoreToNewDb(
  deps: RestoreDeps,
  backupId: string,
): Promise<{ restoredDbName: string; docCount: number }> {
  const backup = usableBackup(deps, backupId);
  const vault = getVault(deps.db, backup.vaultId);
  const restoredDbName = `${vault.couchDbName}-restored-${timestamp()}`;
  await deps.couch.replicate({
    source: authorityUrl(deps.config, backup.location),
    target: authorityUrl(deps.config, restoredDbName),
    create_target: true,
  });
  // Replication skips _local docs, but the E2EE salt lives in one.
  await copyLiveSyncLocalDocs(deps.couch, backup.location, restoredDbName);
  const info = await deps.couch.databaseInfo(restoredDbName);
  recordEvent(deps.db, {
    level: 'info',
    actor: 'admin',
    message: `Restored backup of vault ${vault.name} to ${restoredDbName} (non-destructive)`,
    vaultId: vault.id,
    detail: { backupId, restoredDbName },
  });
  return { restoredDbName, docCount: info.doc_count };
}

export async function restoreSwapConsequences(
  deps: RestoreDeps,
  backupId: string,
): Promise<string[]> {
  const backup = usableBackup(deps, backupId);
  const vault = getVault(deps.db, backup.vaultId);
  let liveCount = 'unknown';
  try {
    liveCount = (await deps.couch.databaseInfo(vault.couchDbName)).doc_count.toLocaleString();
  } catch {
    // Consequences still render if the live database is gone.
  }
  return [
    `The live database ${vault.couchDbName} (${liveCount} docs) will be replaced with the ` +
      `snapshot ${backup.location}` +
      (backup.docCount !== null ? ` (${backup.docCount.toLocaleString()} docs)` : ''),
    'The vault is locked during the swap; a pre-swap safety snapshot is taken first and kept',
    'Afterwards every device must fetch the vault from the server again ' +
      '(in the LiveSync plugin: fetch from the remote database). ' +
      'Replication checkpoints do not survive a swap',
  ];
}

/**
 * Destructive swap (M9): lock, safety-snapshot, replace the live database
 * with the snapshot, restore device access. If replication into the live
 * name fails midway the vault is left locked, with the pre-swap snapshot
 * and the original backup intact. Recover by restoring again or unlocking.
 */
export async function restoreSwap(
  deps: RestoreDeps,
  backupId: string,
): Promise<{ docCount: number; preSwapBackup: string }> {
  const backup = usableBackup(deps, backupId);
  const vault = getVault(deps.db, backup.vaultId);

  await deps.couch.setSecurity(vault.couchDbName, NO_MEMBERS_SECURITY);
  deps.db.prepare('UPDATE vaults SET locked = 1 WHERE id = ?').run(vault.id);
  recordEvent(deps.db, {
    level: 'warn',
    actor: 'admin',
    message: `Locked vault ${vault.name} for restore`,
    vaultId: vault.id,
  });

  const preSwap = `bk-${vault.couchDbName}-preswap-${timestamp()}`;
  await deps.couch.replicate({
    source: authorityUrl(deps.config, vault.couchDbName),
    target: authorityUrl(deps.config, preSwap),
    create_target: true,
  });
  await copyLiveSyncLocalDocs(deps.couch, vault.couchDbName, preSwap);
  const preSwapInfo = await deps.couch.databaseInfo(preSwap);
  deps.db
    .prepare(
      `INSERT INTO backups (id, vault_id, kind, target, location, status, doc_count, size_bytes,
                            started_at, finished_at)
       VALUES (?, ?, 'manual', 'couch-snapshot', ?, 'complete', ?, ?, ?, ?)`,
    )
    .run(
      uuidv7(),
      vault.id,
      preSwap,
      preSwapInfo.doc_count,
      preSwapInfo.sizes.file,
      new Date().toISOString(),
      new Date().toISOString(),
    );

  await deps.couch.deleteDatabase(vault.couchDbName);
  await deps.couch.replicate({
    source: authorityUrl(deps.config, backup.location),
    target: authorityUrl(deps.config, vault.couchDbName),
    create_target: true,
  });
  await copyLiveSyncLocalDocs(deps.couch, backup.location, vault.couchDbName);
  const restored = await deps.couch.databaseInfo(vault.couchDbName);
  if (backup.docCount !== null && restored.doc_count !== backup.docCount) {
    recordEvent(deps.db, {
      level: 'error',
      actor: 'system',
      message:
        `Restore of vault ${vault.name} is incomplete: ${restored.doc_count} docs, ` +
        `snapshot has ${backup.docCount}. The vault stays locked; retry the swap.`,
      vaultId: vault.id,
    });
    throw new VaultError(
      `Restore incomplete (${restored.doc_count} of ${backup.docCount} docs). ` +
        `The vault is still locked and the pre-swap snapshot ${preSwap} is intact; retry the swap.`,
      502,
    );
  }

  await deps.couch.setSecurity(
    vault.couchDbName,
    membersSecurity(activeDeviceUsernames(deps.db, vault.id)),
  );
  deps.db.prepare('UPDATE vaults SET locked = 0 WHERE id = ?').run(vault.id);
  recordEvent(deps.db, {
    level: 'warn',
    actor: 'admin',
    message:
      `Restored vault ${vault.name} from ${backup.location}: every device must now ` +
      `fetch the vault from the server again`,
    vaultId: vault.id,
    detail: { backupId, preSwapBackup: preSwap },
  });
  return { docCount: restored.doc_count, preSwapBackup: preSwap };
}
