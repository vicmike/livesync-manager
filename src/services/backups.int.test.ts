// Backup snapshot + verify against a real CouchDB, using throwaway
// vault-lsc-int-* / bk-vault-lsc-int-* databases.
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CouchClient } from '../couch/client.js';
import { openDatabase } from '../db/index.js';
import { defaultMigrationsDir, runMigrations } from '../db/migrations.js';
import { makeTestConfig } from '../testing.js';
import { deleteBackup, runBackup, verifyBackup, type BackupServiceDeps } from './backups.js';
import { createVault, deleteVault, type VaultServiceDeps } from './vaults.js';

const url = process.env.COUCHDB_TEST_URL ?? 'http://127.0.0.1:5984';
const user = process.env.COUCHDB_TEST_USER ?? 'admin';
const password = process.env.COUCHDB_TEST_PASSWORD ?? 'admin';

const client = new CouchClient({ url, user, password });
const db = openDatabase(':memory:');
const vaultDeps: VaultServiceDeps = { db, couch: client, masterKey: randomBytes(32) };
const config = makeTestConfig({
  COUCHDB_ADMIN_URL: url,
  COUCHDB_ADMIN_USER: user,
  COUCHDB_ADMIN_PASSWORD: password,
});
const backupDeps: BackupServiceDeps = { db, couch: client, config };

beforeAll(async () => {
  runMigrations(db, defaultMigrationsDir());
  const deadline = Date.now() + 90_000;
  for (;;) {
    try {
      await client.up();
      break;
    } catch (err) {
      if (Date.now() > deadline) {
        throw new Error('No CouchDB reachable for integration tests', { cause: err });
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}, 120_000);

afterAll(async () => {
  for (const name of await client.listDatabases()) {
    if (name.startsWith('vault-lsc-int-') || name.startsWith('bk-vault-lsc-int-')) {
      await client.deleteDatabase(name).catch(() => {});
    }
  }
});

describe('backup snapshot on a real CouchDB', () => {
  it('replicates, verifies, and cleans up', async () => {
    const vault = await createVault(vaultDeps, `lsc int m7 ${Date.now()}`);
    for (let i = 0; i < 8; i++) {
      await client.putDocument(vault.couchDbName, `note-${i}`, { body: `content ${i}` });
    }

    const backup = await runBackup(backupDeps, vault.id, 'manual');
    expect(backup.status).toBe('verified');
    expect(backup.docCount).toBe(8);
    const info = await client.databaseInfo(backup.location);
    expect(info.doc_count).toBe(8);

    // Re-verification against the live snapshot passes...
    await verifyBackup(backupDeps, backup.id);
    // ...and fails once the snapshot is tampered with.
    await client.putDocument(backup.location, 'intruder', { oops: true });
    await expect(verifyBackup(backupDeps, backup.id)).rejects.toThrowError(/modified/);

    await deleteBackup(backupDeps, backup.id);
    expect(await client.listDatabases()).not.toContain(backup.location);
    await deleteVault(vaultDeps, vault.id);
  });
});

describe('restore swap on a real CouchDB', () => {
  it('replaces the live database with the snapshot and keeps a pre-swap copy', async () => {
    const { restoreSwap } = await import('./restore.js');
    const vault = await createVault(vaultDeps, `lsc int m9 ${Date.now()}`);
    for (let i = 0; i < 4; i++) {
      await client.putDocument(vault.couchDbName, `note-${i}`, { body: i });
    }
    const backup = await runBackup(backupDeps, vault.id, 'manual');
    await client.putDocument(vault.couchDbName, 'note-after', { body: 'late' });

    const result = await restoreSwap({ db, couch: client, config }, backup.id);
    expect(result.docCount).toBe(4);
    expect((await client.databaseInfo(vault.couchDbName)).doc_count).toBe(4);
    expect((await client.databaseInfo(result.preSwapBackup)).doc_count).toBe(5);

    await client.deleteDatabase(result.preSwapBackup);
    await deleteBackup(backupDeps, backup.id);
    await deleteVault(vaultDeps, vault.id);
  });
});
