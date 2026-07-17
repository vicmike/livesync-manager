import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { openDatabase } from '../db/index.js';
import { defaultMigrationsDir, runMigrations } from '../db/migrations.js';
import { FakeCouch, makeTestConfig } from '../testing.js';
import { listBackups, runBackup, type BackupServiceDeps } from './backups.js';
import { addDevice, type DeviceServiceDeps } from './devices.js';
import { restorePreview, restoreSwap, restoreToNewDb, type RestoreDeps } from './restore.js';
import { createVault, getVault } from './vaults.js';

async function makeFixture() {
  const db = openDatabase(':memory:');
  runMigrations(db, defaultMigrationsDir());
  const fake = new FakeCouch();
  const masterKey = randomBytes(32);
  const config = makeTestConfig();
  const vault = await createVault({ db, couch: fake, masterKey }, 'Personal');
  const deviceDeps: DeviceServiceDeps = { db, couch: fake, masterKey, config };
  const { device } = await addDevice(deviceDeps, vault.id, { name: 'Phone' });
  for (let i = 0; i < 4; i++) {
    await fake.putDocument('vault-personal', `note-${i}`);
  }
  const backupDeps: BackupServiceDeps = { db, couch: fake, config };
  const backup = await runBackup(backupDeps, vault.id, 'manual');
  const deps: RestoreDeps = { db, couch: fake, config };
  return { deps, db, fake, vault, device, backup };
}

describe('restorePreview', () => {
  it('describes the snapshot and the non-destructive target', async () => {
    const { deps, backup } = await makeFixture();
    const preview = await restorePreview(deps, backup.id);
    expect(preview.location).toBe(backup.location);
    expect(preview.docCount).toBe(4);
    expect(preview.restoreTarget).toMatch(/^vault-personal-restored-\d{14}$/);
  });
});

describe('restoreToNewDb', () => {
  it('materializes a sibling database without touching the vault', async () => {
    const { deps, fake, backup } = await makeFixture();
    await fake.putDocument('vault-personal', 'note-after-backup');
    const result = await restoreToNewDb(deps, backup.id);
    expect(result.docCount).toBe(4);
    expect(fake.databases.get(result.restoredDbName)!.docCount).toBe(4);
    expect(fake.databases.get('vault-personal')!.docCount).toBe(5);
  });
});

describe('restoreSwap', () => {
  it('locks, snapshots, swaps, and restores device access', async () => {
    const { deps, db, fake, vault, device, backup } = await makeFixture();
    await fake.putDocument('vault-personal', 'note-to-lose');
    expect(fake.databases.get('vault-personal')!.docCount).toBe(5);

    const result = await restoreSwap(deps, backup.id);
    expect(result.docCount).toBe(4);
    expect(fake.databases.get('vault-personal')!.docCount).toBe(4);

    // Pre-swap snapshot holds the overwritten state and is tracked.
    expect(fake.databases.get(result.preSwapBackup)!.docCount).toBe(5);
    const rows = listBackups(db, vault.id);
    expect(rows.some((b) => b.location === result.preSwapBackup)).toBe(true);

    // Unlocked afterwards, with device access rebuilt.
    expect(getVault(db, vault.id).locked).toBe(false);
    const security = await fake.getSecurity('vault-personal');
    expect(security.members?.names).toEqual([device.couchUsername]);
  });

  it('leaves the vault locked when the restored count is wrong', async () => {
    const { deps, db, vault, backup } = await makeFixture();
    deps.db.prepare('UPDATE backups SET doc_count = 999 WHERE id = ?').run(backup.id);
    await expect(restoreSwap(deps, backup.id)).rejects.toThrowError(/still locked/);
    expect(getVault(db, vault.id).locked).toBe(true);
  });

  it('refuses failed backups', async () => {
    const { deps, backup } = await makeFixture();
    deps.db.prepare("UPDATE backups SET status = 'failed' WHERE id = ?").run(backup.id);
    await expect(restoreSwap(deps, backup.id)).rejects.toThrowError(/only finished backups/);
  });
});
