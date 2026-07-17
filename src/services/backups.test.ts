import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { openDatabase } from '../db/index.js';
import { defaultMigrationsDir, runMigrations } from '../db/migrations.js';
import { FakeCouch, makeTestConfig } from '../testing.js';
import {
  deleteBackup,
  listBackups,
  runBackup,
  verifyBackup,
  type BackupServiceDeps,
} from './backups.js';
import { createVault } from './vaults.js';

async function makeFixture(docCount = 3) {
  const db = openDatabase(':memory:');
  runMigrations(db, defaultMigrationsDir());
  const fake = new FakeCouch();
  const vault = await createVault({ db, couch: fake, masterKey: randomBytes(32) }, 'Personal');
  for (let i = 0; i < docCount; i++) {
    await fake.putDocument('vault-personal', `note-${i}`);
  }
  const deps: BackupServiceDeps = { db, couch: fake, config: makeTestConfig() };
  return { deps, fake, vault };
}

describe('runBackup', () => {
  it('snapshots, records counts, and auto-verifies', async () => {
    const { deps, fake, vault } = await makeFixture();
    const backup = await runBackup(deps, vault.id, 'manual');

    expect(backup.status).toBe('verified');
    expect(backup.docCount).toBe(3);
    expect(backup.location).toMatch(/^bk-vault-personal-\d{14}$/);
    expect(backup.verifiedAt).not.toBeNull();
    expect(fake.databases.get(backup.location)!.docCount).toBe(3);

    const messages = (
      deps.db.prepare('SELECT message FROM events').all() as { message: string }[]
    ).map((e) => e.message);
    expect(messages).toContain('Backed up vault Personal (3 docs)');
    expect(messages.some((m) => m.startsWith('Verified backup of vault Personal'))).toBe(true);
  });

  it('marks the row failed and audits when replication breaks', async () => {
    const { deps, fake, vault } = await makeFixture();
    fake.replicate = () => Promise.reject(new Error('replication exploded'));
    await expect(runBackup(deps, vault.id, 'scheduled')).rejects.toThrowError(
      /replication exploded/,
    );
    const [backup] = listBackups(deps.db, vault.id);
    expect(backup!.status).toBe('failed');
    expect(backup!.finishedAt).not.toBeNull();
    const events = deps.db.prepare("SELECT message FROM events WHERE level = 'error'").all() as {
      message: string;
    }[];
    expect(events[0]!.message).toMatch(/Backup of vault Personal failed/);
  });

  it('refuses to start while another backup runs', async () => {
    const { deps, vault } = await makeFixture();
    deps.db
      .prepare(
        `INSERT INTO backups (id, vault_id, kind, target, location, status, started_at)
         VALUES ('x', ?, 'manual', 'couch-snapshot', 'bk-x', 'running', ?)`,
      )
      .run(vault.id, new Date().toISOString());
    await expect(runBackup(deps, vault.id, 'manual')).rejects.toThrowError(/already running/);
  });
});

describe('verifyBackup', () => {
  it('detects a modified snapshot', async () => {
    const { deps, fake, vault } = await makeFixture();
    const backup = await runBackup(deps, vault.id, 'manual');
    fake.databases.get(backup.location)!.docs.delete('note-1');
    fake.databases.get(backup.location)!.docCount = 2;
    await expect(verifyBackup(deps, backup.id)).rejects.toThrowError(/it was modified/);
  });

  it('refuses to verify failed or running backups', async () => {
    const { deps, fake, vault } = await makeFixture();
    fake.replicate = () => Promise.reject(new Error('nope'));
    await runBackup(deps, vault.id, 'manual').catch(() => {});
    const [failed] = listBackups(deps.db, vault.id);
    await expect(verifyBackup(deps, failed!.id)).rejects.toThrowError(/only finished backups/);
  });
});

describe('deleteBackup', () => {
  it('removes the snapshot database and row', async () => {
    const { deps, fake, vault } = await makeFixture();
    const backup = await runBackup(deps, vault.id, 'manual');
    await deleteBackup(deps, backup.id);
    expect(fake.databases.has(backup.location)).toBe(false);
    expect(listBackups(deps.db, vault.id)).toEqual([]);
  });
});
