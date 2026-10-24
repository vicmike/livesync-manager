import type { AppDatabase } from '../db/index.js';
import type { DatabaseInfo, SecurityObject, UserDoc } from '../couch/client.js';
import { getVault } from './vaults.js';
import { listDevices } from './devices.js';
import {
  MIN_RECOMMENDED_PLUGIN_VERSION,
  refreshVaultNodes,
  type VaultNodesCouch,
} from './vaultNodes.js';

const STALE_BACKUP_MS = 2 * 24 * 60 * 60 * 1000;

export interface VaultHealth {
  vaultId: string;
  couch: { docCount: number; updateSeq: string; sizeBytes: number } | { error: string };
  devices: {
    id: string;
    name: string;
    status: string;
    firstConnected: string | null;
    access: 'configured' | 'drifted' | 'unknown';
  }[];
  /** LiveSync clients seen in the vault's milestone document (approximate). */
  clients: {
    milestone: 'present' | 'absent' | 'unavailable';
    total: number;
    minRecommendedPluginVersion: string;
    outdated: { nodeId: string; label: string; pluginVersion: string | null }[];
  };
  backup: {
    lastFinishedAt: string | null;
    lastVerifiedAt: string | null;
    lastStatus: string | null;
  };
  warnings: string[];
}

export interface VaultHealthCouch extends VaultNodesCouch {
  databaseInfo(name: string): Promise<DatabaseInfo>;
  getSecurity(db: string): Promise<SecurityObject>;
  getUser(name: string): Promise<UserDoc | undefined>;
}

export interface VaultHealthDeps {
  db: AppDatabase;
  couch: VaultHealthCouch;
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

function describeClients(outdated: VaultHealth['clients']['outdated']): string {
  return outdated.map((c) => `${c.label} (${c.pluginVersion ?? 'unknown version'})`).join(', ');
}

/** Human-readable warnings only (AGENTS.md); every string is actionable. */
export async function getVaultHealth(deps: VaultHealthDeps, vaultId: string): Promise<VaultHealth> {
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

  const registeredDevices = listDevices(deps.db, vaultId)
    .filter((d) => d.status !== 'revoked')
    .map((d) => ({
      ...d,
      access: 'unknown' as VaultHealth['devices'][number]['access'],
    }));

  if (!('error' in couch)) {
    try {
      const security = await deps.couch.getSecurity(vault.couchDbName);
      const members = new Set(security.members?.names ?? []);
      await Promise.all(
        registeredDevices.map(async (device) => {
          const user = await deps.couch.getUser(device.couchUsername);
          const missingUser = user === undefined;
          const missingMembership = !members.has(device.couchUsername);
          device.access = missingUser || missingMembership ? 'drifted' : 'configured';
          if (missingUser && missingMembership) {
            warnings.push(
              `Device ${device.name}'s CouchDB account and vault access are missing. Reinvite it before expecting it to sync.`,
            );
          } else if (missingUser) {
            warnings.push(
              `Device ${device.name}'s CouchDB account is missing. Reinvite it before expecting it to sync.`,
            );
          } else if (missingMembership) {
            warnings.push(
              `Device ${device.name}'s CouchDB account is not allowed to access this vault. Reinvite it before expecting it to sync.`,
            );
          }
        }),
      );
    } catch (err) {
      warnings.push(
        `Could not verify device access (${(err as Error).message}). Check CouchDB and try again.`,
      );
    }
  }

  const devices = registeredDevices.map((device) => ({
    id: device.id,
    name: device.name,
    status: device.status,
    firstConnected: device.firstConnected,
    access: device.access,
  }));

  // The milestone document is LiveSync's own record of which clients have
  // connected and which plugin version each runs (LIVESYNC_INTEGRATION.md § 5).
  let clients: VaultHealth['clients'] = {
    milestone: 'unavailable',
    total: 0,
    minRecommendedPluginVersion: MIN_RECOMMENDED_PLUGIN_VERSION,
    outdated: [],
  };
  if (!('error' in couch)) {
    const nodes = await refreshVaultNodes(deps, vaultId);
    clients = {
      milestone: nodes.milestone,
      total: nodes.nodes.length,
      minRecommendedPluginVersion: nodes.minRecommendedPluginVersion,
      outdated: nodes.nodes
        .filter((n) => n.outdated)
        .map((n) => ({ nodeId: n.nodeId, label: n.label, pluginVersion: n.pluginVersion })),
    };
    if (nodes.error !== undefined) {
      warnings.push(
        `Could not read the vault's LiveSync client list (${nodes.error}). Check CouchDB and try again.`,
      );
    }
    if (clients.outdated.length > 0) {
      const plural = clients.outdated.length > 1;
      warnings.push(
        `${plural ? 'LiveSync clients' : 'LiveSync client'} ${describeClients(clients.outdated)} ` +
          `${plural ? 'run' : 'runs'} a plugin older than ${MIN_RECOMMENDED_PLUGIN_VERSION}, ` +
          'which fixed a security issue where synchronised changes could reach files outside ' +
          `the vault. Update Self-hosted LiveSync on ${plural ? 'those devices' : 'that device'}.`,
      );
    }
  }

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

  return { vaultId, couch, devices, clients, backup, warnings };
}
