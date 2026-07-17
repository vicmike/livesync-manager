import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { openDatabase } from '../db/index.js';
import { defaultMigrationsDir, runMigrations } from '../db/migrations.js';
import { FakeCouch, makeTestConfig } from '../testing.js';
import {
  addDevice,
  listDevices,
  markDeviceConnected,
  reinviteDevice,
  renameDevice,
  revokeConsequences,
  revokeDevice,
  type DeviceServiceDeps,
} from './devices.js';
import { consumeInvite, findInvite } from './invites.js';
import { createVault } from './vaults.js';

async function makeFixture() {
  const db = openDatabase(':memory:');
  runMigrations(db, defaultMigrationsDir());
  const fake = new FakeCouch();
  const masterKey = randomBytes(32);
  const vault = await createVault({ db, couch: fake, masterKey }, 'Personal');
  const deps: DeviceServiceDeps = { db, couch: fake, masterKey, config: makeTestConfig() };
  return { deps, fake, vault };
}

function tokenFrom(url: string): string {
  return url.split('/invite/')[1]!;
}

describe('addDevice', () => {
  it('creates the CouchDB user, security entry, row, and invite together', async () => {
    const { deps, fake, vault } = await makeFixture();
    const { device, invite } = await addDevice(deps, vault.id, { name: 'Phone', platform: 'ios' });

    expect(device.status).toBe('pending');
    expect(device.couchUsername).toMatch(/^vault-personal\.phone\.[0-9a-f]{6}$/);
    expect(fake.users.has(device.couchUsername)).toBe(true);
    const security = await fake.getSecurity('vault-personal');
    expect(security.members?.names).toContain(device.couchUsername);
    expect(security.members?.roles).toEqual(['_admin']);
    expect(invite.url).toContain('/invite/');

    const messages = (
      deps.db.prepare('SELECT message FROM events').all() as { message: string }[]
    ).map((e) => e.message);
    expect(messages).toContain('Added device Phone to vault Personal');
  });

  it('rolls everything back when the security update fails', async () => {
    const { deps, fake, vault } = await makeFixture();
    fake.setSecurity = () => Promise.reject(new Error('boom'));
    await expect(addDevice(deps, vault.id, { name: 'Phone' })).rejects.toThrowError('boom');
    expect(fake.users.size).toBe(0);
    expect(deps.db.prepare('SELECT count(*) c FROM devices').get()).toEqual({ c: 0 });
  });

  it('refuses archived vaults', async () => {
    const { deps, vault } = await makeFixture();
    deps.db.prepare("UPDATE vaults SET status = 'archived' WHERE id = ?").run(vault.id);
    await expect(addDevice(deps, vault.id, { name: 'Phone' })).rejects.toThrowError(/Unarchive/);
  });
});

describe('pending to active', () => {
  it('flips on invite consumption and stamps first_connected', async () => {
    const { deps, vault } = await makeFixture();
    const { device, invite } = await addDevice(deps, vault.id, { name: 'Phone' });
    expect(consumeInvite(deps, tokenFrom(invite.url))).toBe(true);
    const after = listDevices(deps.db, vault.id).find((d) => d.id === device.id)!;
    expect(after.status).toBe('active');
    expect(after.firstConnected).not.toBeNull();
    expect(after.lastSeen).not.toBeNull();
  });

  it('flips on markDeviceConnected and closes the unused invite', async () => {
    const { deps, vault } = await makeFixture();
    const { device, invite } = await addDevice(deps, vault.id, { name: 'Laptop' });

    const after = markDeviceConnected(deps.db, device.id);
    expect(after.status).toBe('active');
    expect(after.firstConnected).not.toBeNull();
    expect(findInvite(deps, tokenFrom(invite.url))).toBeUndefined();

    // Idempotent, and never resurrects a revoked device.
    expect(markDeviceConnected(deps.db, device.id).status).toBe('active');
    await revokeDevice(deps, device.id);
    expect(() => markDeviceConnected(deps.db, device.id)).toThrowError(/revoked/);
  });
});

describe('reinviteDevice', () => {
  it('rotates the password and invalidates the previous invite', async () => {
    const { deps, fake, vault } = await makeFixture();
    const first = await addDevice(deps, vault.id, { name: 'Phone' });
    const passwordBefore = fake.users.get(first.device.couchUsername)!.password;
    const encBefore = (
      deps.db
        .prepare('SELECT couch_password_enc e FROM devices WHERE id = ?')
        .get(first.device.id) as { e: Buffer }
    ).e;

    const second = await reinviteDevice(deps, first.device.id);
    expect(fake.users.get(first.device.couchUsername)!.password).not.toBe(passwordBefore);
    const encAfter = (
      deps.db
        .prepare('SELECT couch_password_enc e FROM devices WHERE id = ?')
        .get(first.device.id) as { e: Buffer }
    ).e;
    expect(encAfter.equals(encBefore)).toBe(false);
    expect(findInvite(deps, tokenFrom(first.invite.url))).toBeUndefined();
    expect(findInvite(deps, tokenFrom(second.invite.url))).toBeDefined();
  });

  it('refuses revoked devices', async () => {
    const { deps, vault } = await makeFixture();
    const { device } = await addDevice(deps, vault.id, { name: 'Phone' });
    await revokeDevice(deps, device.id);
    await expect(reinviteDevice(deps, device.id)).rejects.toThrowError(/revoked/);
  });
});

describe('revokeDevice', () => {
  it('removes CouchDB access, invalidates invites, and keeps the audit trail honest', async () => {
    const { deps, fake, vault } = await makeFixture();
    const phone = await addDevice(deps, vault.id, { name: 'Phone' });
    const tablet = await addDevice(deps, vault.id, { name: 'Tablet' });

    const consequences = revokeConsequences(deps.db, phone.device.id);
    expect(consequences.join('\n')).toMatch(/stops syncing immediately/);
    expect(consequences.join('\n')).toMatch(/does not un-share history/);

    const revoked = await revokeDevice(deps, phone.device.id);
    expect(revoked.status).toBe('revoked');
    expect(fake.users.has(phone.device.couchUsername)).toBe(false);
    expect(fake.users.has(tablet.device.couchUsername)).toBe(true);
    const security = await fake.getSecurity('vault-personal');
    expect(security.members?.names).toEqual([tablet.device.couchUsername]);
    expect(findInvite(deps, tokenFrom(phone.invite.url))).toBeUndefined();
  });
});

describe('renameDevice', () => {
  it('renames with an event', async () => {
    const { deps, vault } = await makeFixture();
    const { device } = await addDevice(deps, vault.id, { name: 'Phone' });
    expect(renameDevice(deps.db, device.id, 'Old Phone').name).toBe('Old Phone');
  });
});
