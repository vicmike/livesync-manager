import type { AppDatabase } from '../db/index.js';
import type { VaultServiceDeps } from './vaults.js';
import { getVault } from './vaults.js';
import { listDevices } from './devices.js';

const STALE_BACKUP_MS = 2 * 24 * 60 * 60 * 1000;

export interface VaultHealth {
  vaultId: string;
  couch: { docCount: number; updateSeq: string; sizeBytes: number } | { error: string };
  devices: { name: string; status: string; lastSeen: string | null }[];
  backup: {
    lastFinishedAt: string | null;
    lastVerifiedAt: string | null;
    lastStatus: string | null;
  };
  warnings: string[];
}

function lastBackupInfo(db: AppDatabase, vaultId: string): VaultHealth['backup'] {
  const last = db
    .prepare(
      `SELECT status, finished_at FROM backups WHERE vault_id = ? AND finished_at IS NOT NULL
       ORDER BY finished_at DESC LIMIT 1`,
    )
    .get(vaultId) as { status: string; finished_at: string } | undefined;
  const verified = db
    .prepare(
      `SELECT verified_at FROM backups WHERE vault_id = ? AND verified_at IS NOT NULL
       ORDER BY verified_at DESC LIMIT 1`,
    )
    .get(vaultId) as { verified_at: string } | undefined;
  return {
    lastFinishedAt: last?.finished_at ?? null,
    lastVerifiedAt: verified?.verified_at ?? null,
    lastStatus: last?.status ?? null,
  };
}

/** Human-readable warnings only (AGENTS.md); every string is actionable. */
export async function getVaultHealth(
  deps: VaultServiceDeps,
  vaultId: string,
): Promise<VaultHealth> {
  const vault = getVault(deps.db, vaultId);
  const warnings: string[] = [];

  let couch: VaultHealth['couch'];
  try {
    const info = await deps.couch.databaseInfo(vault.couchDbName);
    couch = { docCount: info.doc_count, updateSeq: info.update_seq, sizeBytes: info.sizes.file };
  } catch (err) {
    couch = { error: (err as Error).message };
    warnings.push(
      `The vault database is unreachable (${(err as Error).message}). ` +
        'Check CouchDB and the server configuration page.',
    );
  }

  const devices = listDevices(deps.db, vaultId)
    .filter((d) => d.status !== 'revoked')
    .map((d) => ({ name: d.name, status: d.status, lastSeen: d.lastSeen }));

  const backup = lastBackupInfo(deps.db, vaultId);
  if (backup.lastFinishedAt === null) {
    warnings.push(
      'This vault has never been backed up. Trigger a backup or wait for the daily run.',
    );
  } else {
    const age = Date.now() - new Date(backup.lastFinishedAt).getTime();
    if (backup.lastStatus === 'failed') {
      warnings.push('The most recent backup failed. Check the events feed and retry.');
    }
    if (age > STALE_BACKUP_MS) {
      const days = Math.floor(age / (24 * 60 * 60 * 1000));
      warnings.push(`Backups are ${days} day(s) old. The daily scheduler may not be running.`);
    }
  }

  return { vaultId, couch, devices, backup, warnings };
}
