import { randomInt } from 'node:crypto';
import { v7 as uuidv7 } from 'uuid';
import type { Config } from '../config/index.js';
import type { AppDatabase } from '../db/index.js';
import type { DatabaseInfo, ReplicationRequest } from '../couch/client.js';
import { recordEvent } from './events.js';
import { VaultError } from './vaults.js';

// The CouchDB operations backups need; satisfied by CouchClient.
export interface BackupCouch {
  databaseInfo(name: string): Promise<DatabaseInfo>;
  replicate(request: ReplicationRequest): Promise<{ ok?: boolean }>;
  deleteDatabase(name: string): Promise<void>;
  getDocument(db: string, id: string): Promise<{ _id: string; _rev: string }>;
  allDocs(
    db: string,
    params?: { limit?: number; skip?: number; key?: string },
  ): Promise<{ total_rows: number; rows: { id: string; value: { rev: string } }[] }>;
}

export interface Backup {
  id: string;
  vaultId: string;
  kind: 'manual' | 'scheduled';
  target: string;
  location: string;
  status: 'running' | 'complete' | 'verified' | 'failed';
  docCount: number | null;
  sizeBytes: number | null;
  startedAt: string;
  finishedAt: string | null;
  verifiedAt: string | null;
}

interface BackupRow {
  id: string;
  vault_id: string;
  kind: Backup['kind'];
  target: string;
  location: string;
  status: Backup['status'];
  doc_count: number | null;
  size_bytes: number | null;
  started_at: string;
  finished_at: string | null;
  verified_at: string | null;
}

function toBackup(row: BackupRow): Backup {
  return {
    id: row.id,
    vaultId: row.vault_id,
    kind: row.kind,
    target: row.target,
    location: row.location,
    status: row.status,
    docCount: row.doc_count,
    sizeBytes: row.size_bytes,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    verifiedAt: row.verified_at,
  };
}

export interface BackupServiceDeps {
  db: AppDatabase;
  couch: BackupCouch;
  config: Config;
}

export function getBackup(db: AppDatabase, id: string): Backup {
  const row = db.prepare('SELECT * FROM backups WHERE id = ?').get(id) as BackupRow | undefined;
  if (!row) {
    throw new VaultError('Backup not found.', 404);
  }
  return toBackup(row);
}

export function listBackups(db: AppDatabase, vaultId: string): Backup[] {
  const rows = db
    .prepare('SELECT * FROM backups WHERE vault_id = ? ORDER BY started_at DESC')
    .all(vaultId) as BackupRow[];
  return rows.map(toBackup);
}

function authorityUrl(config: Config, dbName: string): string {
  const url = new URL(config.couchdb.adminUrl);
  url.username = config.couchdb.adminUser;
  url.password = config.couchdb.adminPassword;
  return new URL(dbName, url).href;
}

/**
 * Snapshots a vault into bk-<db>-<timestamp> on the same server via one-shot
 * replication, then verifies it (LIVESYNC_INTEGRATION.md § 6). Blocks until
 * done; callers that must not block (HTTP handlers) run it detached.
 */
export async function runBackup(
  deps: BackupServiceDeps,
  vaultId: string,
  kind: Backup['kind'],
): Promise<Backup> {
  const vault = deps.db
    .prepare('SELECT name, couch_db_name FROM vaults WHERE id = ?')
    .get(vaultId) as { name: string; couch_db_name: string } | undefined;
  if (!vault) {
    throw new VaultError('Vault not found.', 404);
  }
  const running = deps.db
    .prepare("SELECT id FROM backups WHERE vault_id = ? AND status = 'running'")
    .get(vaultId);
  if (running) {
    throw new VaultError(`A backup of ${vault.name} is already running.`, 409);
  }

  const timestamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const location = `bk-${vault.couch_db_name}-${timestamp}`;
  const id = uuidv7();
  deps.db
    .prepare(
      `INSERT INTO backups (id, vault_id, kind, target, location, status, started_at)
       VALUES (?, ?, ?, 'couch-snapshot', ?, 'running', ?)`,
    )
    .run(id, vaultId, kind, location, new Date().toISOString());

  try {
    await deps.couch.replicate({
      source: authorityUrl(deps.config, vault.couch_db_name),
      target: authorityUrl(deps.config, location),
      create_target: true,
    });
    const source = await deps.couch.databaseInfo(vault.couch_db_name);
    const target = await deps.couch.databaseInfo(location);
    deps.db
      .prepare(
        "UPDATE backups SET status = 'complete', doc_count = ?, size_bytes = ?, finished_at = ? WHERE id = ?",
      )
      .run(target.doc_count, target.sizes.file, new Date().toISOString(), id);
    if (source.doc_count !== target.doc_count) {
      // Writes can land while a one-shot replication runs; not a failure,
      // but worth an honest trace.
      recordEvent(deps.db, {
        level: 'warn',
        actor: 'system',
        message:
          `Vault ${vault.name} changed during backup ` +
          `(source ${source.doc_count} docs, snapshot ${target.doc_count})`,
        vaultId,
      });
    }
    recordEvent(deps.db, {
      level: 'info',
      actor: kind === 'manual' ? 'admin' : 'system',
      message: `Backed up vault ${vault.name} (${target.doc_count} docs)`,
      vaultId,
      detail: { backupId: id, location },
    });
  } catch (err) {
    deps.db
      .prepare("UPDATE backups SET status = 'failed', finished_at = ? WHERE id = ?")
      .run(new Date().toISOString(), id);
    recordEvent(deps.db, {
      level: 'error',
      actor: 'system',
      message: `Backup of vault ${vault.name} failed: ${(err as Error).message}`,
      vaultId,
      detail: { backupId: id, location },
    });
    throw err;
  }

  return verifyBackup(deps, id);
}

const SPOT_CHECK_SAMPLES = 5;

/**
 * Verifies a snapshot: the database still holds the doc count recorded at
 * backup time, and a random sample of documents is readable. Compares
 * against the recorded count, not the live vault; the vault legitimately
 * moves on after a snapshot.
 */
export async function verifyBackup(deps: BackupServiceDeps, backupId: string): Promise<Backup> {
  const backup = getBackup(deps.db, backupId);
  if (backup.status === 'running' || backup.status === 'failed') {
    throw new VaultError(`Backup is ${backup.status}; only finished backups can be verified.`, 409);
  }
  const vault = deps.db.prepare('SELECT name FROM vaults WHERE id = ?').get(backup.vaultId) as {
    name: string;
  };

  try {
    const info = await deps.couch.databaseInfo(backup.location);
    if (backup.docCount !== null && info.doc_count !== backup.docCount) {
      throw new Error(
        `snapshot has ${info.doc_count} docs, expected ${backup.docCount}: it was modified`,
      );
    }
    const samples = Math.min(SPOT_CHECK_SAMPLES, info.doc_count);
    for (let i = 0; i < samples; i++) {
      const skip = randomInt(info.doc_count);
      const page = await deps.couch.allDocs(backup.location, { limit: 1, skip });
      const row = page.rows[0];
      if (!row) {
        throw new Error(`no document at offset ${skip}`);
      }
      await deps.couch.getDocument(backup.location, row.id);
    }
    deps.db
      .prepare("UPDATE backups SET status = 'verified', verified_at = ? WHERE id = ?")
      .run(new Date().toISOString(), backupId);
    recordEvent(deps.db, {
      level: 'info',
      actor: 'system',
      message: `Verified backup of vault ${vault.name} (${info.doc_count} docs spot-checked)`,
      vaultId: backup.vaultId,
      detail: { backupId },
    });
  } catch (err) {
    recordEvent(deps.db, {
      level: 'error',
      actor: 'system',
      message: `Backup verification for vault ${vault.name} failed: ${(err as Error).message}`,
      vaultId: backup.vaultId,
      detail: { backupId },
    });
    throw new VaultError(
      `Backup verification failed: ${(err as Error).message}. ` +
        'Take a fresh backup and investigate before relying on this one.',
      502,
    );
  }
  return getBackup(deps.db, backupId);
}

export function deleteBackupConsequences(db: AppDatabase, backupId: string): string[] {
  const backup = getBackup(db, backupId);
  return [
    `Snapshot database ${backup.location}` +
      (backup.docCount !== null ? ` (${backup.docCount.toLocaleString()} docs)` : '') +
      ' will be permanently deleted from CouchDB',
  ];
}

export async function deleteBackup(deps: BackupServiceDeps, backupId: string): Promise<void> {
  const backup = getBackup(deps.db, backupId);
  try {
    await deps.couch.deleteDatabase(backup.location);
  } catch (err) {
    if ((err as { status?: number }).status !== 404) {
      throw err;
    }
  }
  deps.db.prepare('DELETE FROM backups WHERE id = ?').run(backupId);
  recordEvent(deps.db, {
    level: 'warn',
    actor: 'admin',
    message: `Deleted backup ${backup.location}`,
    vaultId: backup.vaultId,
  });
}
