import { randomBytes } from 'node:crypto';
import { v7 as uuidv7 } from 'uuid';
import type { Config } from '../config/index.js';
import { encryptSecret } from '../crypto/index.js';
import type { AppDatabase } from '../db/index.js';
import type { SecurityObject } from '../couch/client.js';
import { createInvite, type CreatedInvite } from './invites.js';
import { recordEvent } from './events.js';
import { VaultError } from './vaults.js';

// The CouchDB operations device lifecycle needs; satisfied by CouchClient.
export interface DeviceCouch {
  putUser(name: string, password: string): Promise<void>;
  deleteUser(name: string): Promise<void>;
  getSecurity(db: string): Promise<SecurityObject>;
  setSecurity(db: string, security: SecurityObject): Promise<void>;
}

export interface Device {
  id: string;
  vaultId: string;
  name: string;
  platform: string | null;
  couchUsername: string;
  status: 'pending' | 'active' | 'revoked';
  firstConnected: string | null;
  lastSeen: string | null;
  revokedAt: string | null;
  createdAt: string;
}

interface DeviceRow {
  id: string;
  vault_id: string;
  name: string;
  platform: string | null;
  couch_username: string;
  status: Device['status'];
  first_connected: string | null;
  last_seen: string | null;
  revoked_at: string | null;
  created_at: string;
}

function toDevice(row: DeviceRow): Device {
  return {
    id: row.id,
    vaultId: row.vault_id,
    name: row.name,
    platform: row.platform,
    couchUsername: row.couch_username,
    status: row.status,
    firstConnected: row.first_connected,
    lastSeen: row.last_seen,
    revokedAt: row.revoked_at,
    createdAt: row.created_at,
  };
}

export interface DeviceServiceDeps {
  db: AppDatabase;
  couch: DeviceCouch;
  masterKey: Buffer;
  config: Config;
}

export function getDevice(db: AppDatabase, id: string): Device {
  const row = db.prepare('SELECT * FROM devices WHERE id = ?').get(id) as DeviceRow | undefined;
  if (!row) {
    throw new VaultError('Device not found.', 404);
  }
  return toDevice(row);
}

export function listDevices(db: AppDatabase, vaultId: string): Device[] {
  const rows = db
    .prepare('SELECT * FROM devices WHERE vault_id = ? ORDER BY created_at')
    .all(vaultId) as DeviceRow[];
  return rows.map(toDevice);
}

function deviceSlug(name: string): string {
  const slug = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24);
  return slug || 'device';
}

function membersWithout(security: SecurityObject, username: string): SecurityObject {
  return {
    admins: security.admins ?? { names: [], roles: [] },
    members: {
      names: (security.members?.names ?? []).filter((n) => n !== username),
      roles: security.members?.roles ?? ['_admin'],
    },
  };
}

function membersWith(security: SecurityObject, username: string): SecurityObject {
  const without = membersWithout(security, username);
  return {
    ...without,
    members: { ...without.members, names: [...without.members!.names!, username] },
  };
}

export async function addDevice(
  deps: DeviceServiceDeps,
  vaultId: string,
  input: { name: string; platform?: string | undefined },
): Promise<{ device: Device; invite: CreatedInvite }> {
  const name = input.name.trim();
  if (name.length === 0 || name.length > 64) {
    throw new VaultError('Device name must be 1-64 characters.', 400);
  }
  const vault = deps.db
    .prepare('SELECT name, couch_db_name, status, locked FROM vaults WHERE id = ?')
    .get(vaultId) as
    { name: string; couch_db_name: string; status: string; locked: number } | undefined;
  if (!vault) {
    throw new VaultError('Vault not found.', 404);
  }
  if (vault.status !== 'active') {
    throw new VaultError(
      `Vault ${vault.name} is ${vault.status}. Unarchive it before adding devices.`,
      409,
    );
  }
  if (vault.locked === 1) {
    throw new VaultError(`Vault ${vault.name} is locked. Unlock it before adding devices.`, 409);
  }

  const id = uuidv7();
  const couchUsername = `${vault.couch_db_name}.${deviceSlug(name)}.${randomBytes(3).toString('hex')}`;
  const couchPassword = randomBytes(24).toString('base64url');

  await deps.couch.putUser(couchUsername, couchPassword);
  try {
    await deps.couch.setSecurity(
      vault.couch_db_name,
      membersWith(await deps.couch.getSecurity(vault.couch_db_name), couchUsername),
    );
  } catch (err) {
    await deps.couch.deleteUser(couchUsername).catch(() => {});
    throw err;
  }

  let invite: CreatedInvite;
  try {
    deps.db
      .prepare(
        `INSERT INTO devices (id, vault_id, name, platform, couch_username, couch_password_enc,
                              status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`,
      )
      .run(
        id,
        vaultId,
        name,
        input.platform ?? null,
        couchUsername,
        encryptSecret(deps.masterKey, couchPassword, {
          table: 'devices',
          column: 'couch_password_enc',
          rowId: id,
        }),
        new Date().toISOString(),
      );
    invite = await createInvite(deps, {
      vaultId,
      deviceId: id,
      couchUsername,
      couchPassword,
    });
  } catch (err) {
    deps.db.prepare('DELETE FROM invites WHERE device_id = ?').run(id);
    deps.db.prepare('DELETE FROM devices WHERE id = ?').run(id);
    await deps.couch
      .setSecurity(
        vault.couch_db_name,
        membersWithout(await deps.couch.getSecurity(vault.couch_db_name), couchUsername),
      )
      .catch(() => {});
    await deps.couch.deleteUser(couchUsername).catch(() => {});
    throw err;
  }

  recordEvent(deps.db, {
    level: 'info',
    actor: 'admin',
    message: `Added device ${name} to vault ${vault.name}`,
    vaultId,
    deviceId: id,
  });
  return { device: getDevice(deps.db, id), invite };
}

export function renameDevice(db: AppDatabase, id: string, name: string): Device {
  const device = getDevice(db, id);
  const trimmed = name.trim();
  if (trimmed.length === 0 || trimmed.length > 64) {
    throw new VaultError('Device name must be 1-64 characters.', 400);
  }
  db.prepare('UPDATE devices SET name = ? WHERE id = ?').run(trimmed, id);
  recordEvent(db, {
    level: 'info',
    actor: 'admin',
    message: `Renamed device ${device.name} to ${trimmed}`,
    vaultId: device.vaultId,
    deviceId: id,
  });
  return getDevice(db, id);
}

/**
 * Admin confirmation that a pending device is syncing. Needed because the
 * automatic signal is the invite page's "I've imported it" button, which is
 * easy to skip; the device then syncs fine but stays pending here.
 */
export function markDeviceConnected(db: AppDatabase, deviceId: string): Device {
  const device = getDevice(db, deviceId);
  if (device.status === 'revoked') {
    throw new VaultError(
      'This device was revoked. Add it as a new device instead of marking it connected.',
      409,
    );
  }
  if (device.status === 'pending') {
    const now = new Date().toISOString();
    db.prepare(
      `UPDATE devices SET status = 'active', first_connected = COALESCE(first_connected, ?),
       last_seen = ? WHERE id = ?`,
    ).run(now, now, deviceId);
    // The invite is no longer needed; leaving it live only extends the
    // window in which its credentials can be fetched.
    db.prepare('DELETE FROM invites WHERE device_id = ? AND used_at IS NULL').run(deviceId);
    recordEvent(db, {
      level: 'info',
      actor: 'admin',
      message: `Marked device ${device.name} as connected`,
      vaultId: device.vaultId,
      deviceId,
    });
  }
  return getDevice(db, deviceId);
}

/** Rotates the device's CouchDB password and issues a fresh invite. */
export async function reinviteDevice(
  deps: DeviceServiceDeps,
  deviceId: string,
): Promise<{ device: Device; invite: CreatedInvite }> {
  const device = getDevice(deps.db, deviceId);
  if (device.status === 'revoked') {
    throw new VaultError(
      'This device was revoked. Add it as a new device instead of reinviting.',
      409,
    );
  }
  const couchPassword = randomBytes(24).toString('base64url');
  await deps.couch.putUser(device.couchUsername, couchPassword);
  deps.db.prepare('UPDATE devices SET couch_password_enc = ? WHERE id = ?').run(
    encryptSecret(deps.masterKey, couchPassword, {
      table: 'devices',
      column: 'couch_password_enc',
      rowId: deviceId,
    }),
    deviceId,
  );
  const invite = await createInvite(deps, {
    vaultId: device.vaultId,
    deviceId,
    couchUsername: device.couchUsername,
    couchPassword,
  });
  recordEvent(deps.db, {
    level: 'info',
    actor: 'admin',
    message: `Reinvited device ${device.name} (credentials rotated)`,
    vaultId: device.vaultId,
    deviceId,
  });
  return { device: getDevice(deps.db, deviceId), invite };
}

export function revokeConsequences(db: AppDatabase, deviceId: string): string[] {
  const device = getDevice(db, deviceId);
  return [
    `CouchDB user ${device.couchUsername} will be deleted: ${device.name} stops syncing immediately`,
    'Any pending invite for this device will be invalidated',
    `${device.name} keeps its local vault copy and knows the vault encryption passphrase: ` +
      'revocation stops future sync, it does not un-share history',
  ];
}

export async function revokeDevice(deps: DeviceServiceDeps, deviceId: string): Promise<Device> {
  const device = getDevice(deps.db, deviceId);
  if (device.status === 'revoked') {
    return device;
  }
  const vault = deps.db
    .prepare('SELECT couch_db_name FROM vaults WHERE id = ?')
    .get(device.vaultId) as { couch_db_name: string };

  // CouchDB side first; metadata only flips once access is actually gone.
  await deps.couch.setSecurity(
    vault.couch_db_name,
    membersWithout(await deps.couch.getSecurity(vault.couch_db_name), device.couchUsername),
  );
  await deps.couch.deleteUser(device.couchUsername);

  deps.db.prepare('DELETE FROM invites WHERE device_id = ? AND used_at IS NULL').run(deviceId);
  deps.db
    .prepare("UPDATE devices SET status = 'revoked', revoked_at = ? WHERE id = ?")
    .run(new Date().toISOString(), deviceId);
  recordEvent(deps.db, {
    level: 'warn',
    actor: 'admin',
    message: `Revoked device ${device.name}`,
    vaultId: device.vaultId,
    deviceId,
  });
  return getDevice(deps.db, deviceId);
}
