import { CouchError } from '../couch/client.js';
import type { AppDatabase } from '../db/index.js';
import { getDevice, type Device } from './devices.js';
import { recordEvent } from './events.js';
import { getVault, VaultError } from './vaults.js';

/**
 * LiveSync's per-vault bookkeeping document (LIVESYNC_INTEGRATION.md § 5).
 * Every client rewrites it when replication opens; we only ever read it. A
 * write from us would race each client's compatibility check.
 */
export const MILESTONE_DOC_ID = '_local/obsydian_livesync_milestone';

/** Pseudo node under which LiveSync keeps the vault-wide preferred tweak values. */
const PREFERRED_NODE_ID = 'PREFERRED';

import { MIN_RECOMMENDED_PLUGIN_VERSION } from './pluginVersion.js';
export { MIN_RECOMMENDED_PLUGIN_VERSION };

/**
 * A client first observed within this long after a device's onboarding was
 * confirmed is attributed to that device, when both sides are unambiguous.
 */
const AUTO_LINK_WINDOW_MS = 60 * 60 * 1000;

/**
 * LiveSync never removes a client from its milestone document: reinstalls,
 * retired devices and wiped vaults stay listed forever (plugin 1.0.40's
 * "Review devices" can forget them by hand). A client that has not connected
 * for this long is shown as stale and left out of the outdated-plugin
 * warning, so the warning names devices that are actually in use.
 */
export const STALE_AFTER_DAYS = 30;
const STALE_AFTER_MS = STALE_AFTER_DAYS * 24 * 60 * 60 * 1000;

export function isStaleNode(lastConnected: string | null, now: Date = new Date()): boolean {
  if (lastConnected === null) return true;
  const at = Date.parse(lastConnected);
  return Number.isNaN(at) || now.getTime() - at > STALE_AFTER_MS;
}

export interface ProjectedNode {
  nodeId: string;
  accepted: boolean;
  deviceName: string | null;
  vaultName: string | null;
  pluginVersion: string | null;
  appVersion: string | null;
  platform: string | null;
  /** ISO timestamp; null until the client has connected once. */
  lastConnected: string | null;
}

export interface ProjectedMilestone {
  present: boolean;
  locked: boolean;
  cleaned: boolean;
  nodes: ProjectedNode[];
}

export interface VaultNode extends ProjectedNode {
  vaultId: string;
  /** Human label: LiveSync's own device name, else a short node id. */
  label: string;
  firstSeen: string;
  lastObserved: string;
  outdated: boolean;
  /** Not connected for STALE_AFTER_DAYS (or never): likely a retired install. */
  stale: boolean;
  /** The managed device this client is linked to, if any. */
  device: { id: string; name: string } | null;
}

export interface VaultNodesResult {
  vaultId: string;
  /**
   * present: the document was read; absent: no client has connected yet;
   * unavailable: CouchDB could not be read and `nodes` are the last stored
   * observations.
   */
  milestone: 'present' | 'absent' | 'unavailable';
  locked: boolean;
  error?: string;
  minRecommendedPluginVersion: string;
  nodes: VaultNode[];
}

export interface VaultNodesCouch {
  getLocalDoc(db: string, id: string): Promise<Record<string, unknown> & { _rev: string }>;
}

export interface VaultNodesDeps {
  db: AppDatabase;
  couch: VaultNodesCouch;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function readString(record: Record<string, unknown> | undefined, key: string): string | null {
  const value = record?.[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function readTimestamp(value: unknown): string | null {
  // LiveSync initialises last_connected to 0 and bumps it on connect.
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  return new Date(value).toISOString();
}

function addKeys(ids: Set<string>, value: unknown): void {
  const record = asRecord(value);
  if (!record) return;
  for (const id of Object.keys(record)) {
    if (id !== PREFERRED_NODE_ID) ids.add(id);
  }
}

/**
 * Mirrors commonlib's projectJoinedDevices: node ids are the union of
 * accepted_nodes and the keys of node_info / node_chunk_info / tweak_values,
 * minus the PREFERRED pseudo node.
 */
export function projectMilestone(doc: unknown): ProjectedMilestone {
  const source = asRecord(doc);
  if (!source) {
    return { present: false, locked: false, cleaned: false, nodes: [] };
  }
  const acceptedNodes = Array.isArray(source.accepted_nodes)
    ? source.accepted_nodes.filter((id): id is string => typeof id === 'string')
    : [];
  const accepted = new Set(acceptedNodes);
  const ids = new Set<string>();
  for (const id of acceptedNodes) {
    if (id !== PREFERRED_NODE_ID) ids.add(id);
  }
  addKeys(ids, source.node_info);
  addKeys(ids, source.node_chunk_info);
  addKeys(ids, source.tweak_values);
  const nodeInfo = asRecord(source.node_info);
  const nodes = [...ids].sort().map((nodeId) => {
    const info = asRecord(nodeInfo?.[nodeId]);
    return {
      nodeId,
      accepted: accepted.has(nodeId),
      deviceName: readString(info, 'device_name'),
      vaultName: readString(info, 'vault_name'),
      pluginVersion: readString(info, 'plugin_version'),
      appVersion: readString(info, 'app_version'),
      platform: readString(info, 'platform'),
      lastConnected: readTimestamp(info?.last_connected),
    };
  });
  return {
    present: true,
    locked: source.locked === true,
    cleaned: source.cleaned === true,
    nodes,
  };
}

/**
 * Compares dotted version strings numerically (a pre-release suffix sorts
 * before its release). Returns null when either side is not a version.
 */
export function compareVersions(a: string, b: string): -1 | 0 | 1 | null {
  const parse = (v: string) => {
    const match = /^v?(\d+(?:\.\d+)*)(?:-([0-9A-Za-z.-]+))?$/.exec(v.trim());
    if (!match) return null;
    return { nums: match[1]!.split('.').map(Number), pre: match[2] ?? null };
  };
  const pa = parse(a);
  const pb = parse(b);
  if (!pa || !pb) return null;
  const len = Math.max(pa.nums.length, pb.nums.length);
  for (let i = 0; i < len; i++) {
    const diff = (pa.nums[i] ?? 0) - (pb.nums[i] ?? 0);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  if (pa.pre === pb.pre) return 0;
  if (pa.pre === null) return 1;
  if (pb.pre === null) return -1;
  return pa.pre < pb.pre ? -1 : 1;
}

/** Unknown or unparsable versions are not flagged; only a known-older one is. */
export function isOutdatedPlugin(version: string | null): boolean {
  if (version === null) return false;
  const cmp = compareVersions(version, MIN_RECOMMENDED_PLUGIN_VERSION);
  return cmp !== null && cmp < 0;
}

export function nodeLabel(node: { nodeId: string; deviceName: string | null }): string {
  return node.deviceName ?? `client ${node.nodeId.slice(0, 8)}`;
}

interface NodeRow {
  vault_id: string;
  node_id: string;
  device_name: string | null;
  vault_name: string | null;
  plugin_version: string | null;
  app_version: string | null;
  platform: string | null;
  accepted: number;
  last_connected: string | null;
  first_seen: string;
  last_observed: string;
  device_id: string | null;
  device_label: string | null;
}

function toNode(row: NodeRow, now: Date): VaultNode {
  return {
    vaultId: row.vault_id,
    nodeId: row.node_id,
    label: nodeLabel({ nodeId: row.node_id, deviceName: row.device_name }),
    accepted: row.accepted === 1,
    deviceName: row.device_name,
    vaultName: row.vault_name,
    pluginVersion: row.plugin_version,
    appVersion: row.app_version,
    platform: row.platform,
    lastConnected: row.last_connected,
    firstSeen: row.first_seen,
    lastObserved: row.last_observed,
    outdated: isOutdatedPlugin(row.plugin_version),
    stale: isStaleNode(row.last_connected, now),
    device: row.device_id ? { id: row.device_id, name: row.device_label ?? '' } : null,
  };
}

/** Stored observations for a vault, most recently connected first. */
export function listVaultNodes(
  db: AppDatabase,
  vaultId: string,
  now: Date = new Date(),
): VaultNode[] {
  const rows = db
    .prepare(
      `SELECT n.*, d.id AS device_id, d.name AS device_label
       FROM vault_nodes n
       LEFT JOIN devices d ON d.vault_id = n.vault_id AND d.livesync_node_id = n.node_id
       WHERE n.vault_id = ?
       ORDER BY n.last_connected IS NULL, n.last_connected DESC, n.node_id`,
    )
    .all(vaultId) as NodeRow[];
  return rows.map((row) => toNode(row, now));
}

function upsertNodes(db: AppDatabase, vaultId: string, nodes: ProjectedNode[], now: string): void {
  const upsert = db.prepare(
    `INSERT INTO vault_nodes (vault_id, node_id, device_name, vault_name, plugin_version,
                              app_version, platform, accepted, last_connected, first_seen,
                              last_observed)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(vault_id, node_id) DO UPDATE SET
       device_name    = excluded.device_name,
       vault_name     = excluded.vault_name,
       plugin_version = excluded.plugin_version,
       app_version    = excluded.app_version,
       platform       = COALESCE(excluded.platform, vault_nodes.platform),
       accepted       = excluded.accepted,
       last_connected = CASE
         WHEN excluded.last_connected IS NULL THEN vault_nodes.last_connected
         WHEN vault_nodes.last_connected IS NULL THEN excluded.last_connected
         WHEN excluded.last_connected > vault_nodes.last_connected THEN excluded.last_connected
         ELSE vault_nodes.last_connected END,
       last_observed  = excluded.last_observed`,
  );
  for (const node of nodes) {
    upsert.run(
      vaultId,
      node.nodeId,
      node.deviceName,
      node.vaultName,
      node.pluginVersion,
      node.appVersion,
      node.platform,
      node.accepted ? 1 : 0,
      node.lastConnected,
      now,
      now,
    );
  }
}

interface LinkCandidateDevice {
  id: string;
  name: string;
  first_connected: string;
}

interface UnlinkedNode {
  node_id: string;
  device_name: string | null;
  first_seen: string;
}

function withinLinkWindow(node: UnlinkedNode, device: LinkCandidateDevice): boolean {
  const seen = Date.parse(node.first_seen);
  const start = Date.parse(device.first_connected);
  return seen >= start && seen - start <= AUTO_LINK_WINDOW_MS;
}

/**
 * Attributes newly observed clients to devices by onboarding time: a client
 * first seen within the hour after exactly one unlinked device confirmed its
 * connection, when it is also the only new client in that device's window.
 * Anything ambiguous is left for the admin to link by hand.
 */
function autoLinkNodes(db: AppDatabase, vaultId: string): void {
  const nodes = db
    .prepare(
      `SELECT n.node_id, n.device_name, n.first_seen FROM vault_nodes n
       WHERE n.vault_id = ?
         AND NOT EXISTS (SELECT 1 FROM devices d
                         WHERE d.vault_id = n.vault_id AND d.livesync_node_id = n.node_id)`,
    )
    .all(vaultId) as UnlinkedNode[];
  const devices = db
    .prepare(
      `SELECT id, name, first_connected FROM devices
       WHERE vault_id = ? AND status != 'revoked' AND livesync_node_id IS NULL
         AND first_connected IS NOT NULL`,
    )
    .all(vaultId) as LinkCandidateDevice[];
  if (nodes.length === 0 || devices.length === 0) return;

  const link = db.prepare('UPDATE devices SET livesync_node_id = ? WHERE id = ?');
  for (const node of nodes) {
    const matches = devices.filter((device) => withinLinkWindow(node, device));
    if (matches.length !== 1) continue;
    const device = matches[0]!;
    if (nodes.filter((other) => withinLinkWindow(other, device)).length !== 1) continue;
    link.run(node.node_id, device.id);
    devices.splice(devices.indexOf(device), 1);
    recordEvent(db, {
      level: 'info',
      actor: 'system',
      message:
        `Linked device ${device.name} to LiveSync client ` +
        `${nodeLabel({ nodeId: node.node_id, deviceName: node.device_name })} ` +
        '(matched by onboarding time; approximate)',
      vaultId,
      deviceId: device.id,
      detail: { nodeId: node.node_id },
    });
  }
}

/** Linked devices inherit their client's last connection as "last seen", never moving backwards. */
function propagateLastSeen(db: AppDatabase, vaultId: string): void {
  db.prepare(
    `UPDATE devices SET last_seen = (
       SELECT n.last_connected FROM vault_nodes n
       WHERE n.vault_id = devices.vault_id AND n.node_id = devices.livesync_node_id)
     WHERE vault_id = ? AND livesync_node_id IS NOT NULL
       AND (SELECT n.last_connected FROM vault_nodes n
            WHERE n.vault_id = devices.vault_id AND n.node_id = devices.livesync_node_id) IS NOT NULL
       AND (last_seen IS NULL OR last_seen < (
            SELECT n.last_connected FROM vault_nodes n
            WHERE n.vault_id = devices.vault_id AND n.node_id = devices.livesync_node_id))`,
  ).run(vaultId);
}

/**
 * Reads the vault's milestone document and refreshes the stored client
 * observations, linking new clients to devices where unambiguous. Read-only
 * toward CouchDB. A CouchDB failure is reported, not thrown: the stored
 * observations are still worth showing.
 */
export async function refreshVaultNodes(
  deps: VaultNodesDeps,
  vaultId: string,
  now: Date = new Date(),
): Promise<VaultNodesResult> {
  const vault = getVault(deps.db, vaultId);
  let doc: Record<string, unknown> | undefined;
  let milestone: VaultNodesResult['milestone'] = 'present';
  let error: string | undefined;
  try {
    doc = await deps.couch.getLocalDoc(vault.couchDbName, MILESTONE_DOC_ID);
  } catch (err) {
    if (err instanceof CouchError && err.status === 404) {
      milestone = 'absent';
    } else {
      milestone = 'unavailable';
      error = (err as Error).message;
    }
  }
  const projected = projectMilestone(doc);
  if (projected.present) {
    deps.db.transaction(() => {
      upsertNodes(deps.db, vaultId, projected.nodes, now.toISOString());
      autoLinkNodes(deps.db, vaultId);
      propagateLastSeen(deps.db, vaultId);
    })();
  }
  return {
    vaultId,
    milestone,
    locked: projected.locked,
    ...(error !== undefined ? { error } : {}),
    minRecommendedPluginVersion: MIN_RECOMMENDED_PLUGIN_VERSION,
    nodes: listVaultNodes(deps.db, vaultId, now),
  };
}

function storedNode(
  db: AppDatabase,
  vaultId: string,
  nodeId: string,
): { nodeId: string; deviceName: string | null } | undefined {
  const row = db
    .prepare('SELECT node_id, device_name FROM vault_nodes WHERE vault_id = ? AND node_id = ?')
    .get(vaultId, nodeId) as { node_id: string; device_name: string | null } | undefined;
  return row ? { nodeId: row.node_id, deviceName: row.device_name } : undefined;
}

/** Admin override of the client ↔ device link; `null` unlinks. */
export function setDeviceNode(db: AppDatabase, deviceId: string, nodeId: string | null): Device {
  const device = getDevice(db, deviceId);
  if (device.status === 'revoked') {
    throw new VaultError('This device was revoked; it cannot be linked to a LiveSync client.', 409);
  }
  const { livesync_node_id: currentNodeId } = db
    .prepare('SELECT livesync_node_id FROM devices WHERE id = ?')
    .get(deviceId) as { livesync_node_id: string | null };

  if (nodeId === null) {
    if (currentNodeId === null) return device;
    db.prepare('UPDATE devices SET livesync_node_id = NULL WHERE id = ?').run(deviceId);
    recordEvent(db, {
      level: 'info',
      actor: 'admin',
      message: `Unlinked device ${device.name} from LiveSync client ${nodeLabel(
        storedNode(db, device.vaultId, currentNodeId) ?? {
          nodeId: currentNodeId,
          deviceName: null,
        },
      )}`,
      vaultId: device.vaultId,
      deviceId,
      detail: { nodeId: currentNodeId },
    });
    return getDevice(db, deviceId);
  }

  const node = storedNode(db, device.vaultId, nodeId);
  if (!node) {
    throw new VaultError(
      'No LiveSync client with that id has been seen on this vault. ' +
        'Refresh the vault page and pick one from the LiveSync clients list.',
      404,
    );
  }
  const holder = db
    .prepare('SELECT id, name FROM devices WHERE vault_id = ? AND livesync_node_id = ? AND id != ?')
    .get(device.vaultId, nodeId, deviceId) as { id: string; name: string } | undefined;
  if (holder) {
    throw new VaultError(
      `That LiveSync client is already linked to device ${holder.name}. Unlink it there first.`,
      409,
    );
  }
  if (currentNodeId === nodeId) return device;
  db.transaction(() => {
    db.prepare('UPDATE devices SET livesync_node_id = ? WHERE id = ?').run(nodeId, deviceId);
    propagateLastSeen(db, device.vaultId);
  })();
  recordEvent(db, {
    level: 'info',
    actor: 'admin',
    message: `Linked device ${device.name} to LiveSync client ${nodeLabel(node)}`,
    vaultId: device.vaultId,
    deviceId,
    detail: { nodeId },
  });
  return getDevice(db, deviceId);
}
