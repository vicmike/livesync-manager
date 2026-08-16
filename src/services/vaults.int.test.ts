// Vault lifecycle against a real CouchDB, using throwaway vault-lsc-int-*
// databases (cleaned up afterwards). Target selection as in couch.int.test.ts.
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CouchClient } from '../couch/client.js';
import { openDatabase } from '../db/index.js';
import { defaultMigrationsDir, runMigrations } from '../db/migrations.js';
import { createVault, deleteVault, getVaultDetail, type VaultServiceDeps } from './vaults.js';

const client = new CouchClient({
  url: process.env.COUCHDB_TEST_URL ?? 'http://127.0.0.1:5984',
  user: process.env.COUCHDB_TEST_USER ?? 'admin',
  password: process.env.COUCHDB_TEST_PASSWORD ?? 'admin',
});

const NAME = `lsc int m4 ${Date.now()}`;
const db = openDatabase(':memory:');
const deps: VaultServiceDeps = { db, couch: client, masterKey: randomBytes(32) };

beforeAll(async () => {
  runMigrations(db, defaultMigrationsDir());
  const deadline = Date.now() + 90_000;
  for (;;) {
    try {
      await client.up();
      break;
    } catch (err) {
      if (Date.now() > deadline) {
        throw new Error(`No CouchDB reachable for integration tests`, { cause: err });
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}, 120_000);

afterAll(async () => {
  for (const name of await client.listDatabases()) {
    if (name.startsWith('vault-lsc-int-')) {
      await client.deleteDatabase(name).catch(() => {});
    }
  }
});

describe('vault lifecycle on a real CouchDB', () => {
  it('creates a locked-down database and deletes it again', async () => {
    const vault = await createVault(deps, NAME);
    expect(vault.couchDbName.startsWith('vault-lsc-int-')).toBe(true);

    const security = await client.getSecurity(vault.couchDbName);
    expect(security.members?.roles).toEqual(['_admin']);

    const detail = await getVaultDetail(deps, vault.id);
    // The stamped obsydian_livesync_version marker counts as a doc.
    expect(detail.couch).toMatchObject({ docCount: 1 });

    await deleteVault(deps, vault.id);
    expect(await client.listDatabases()).not.toContain(vault.couchDbName);
  });

  it('refuses to create over an existing database', async () => {
    const stray = `vault-lsc-int-stray-${Date.now()}`;
    await client.createDatabase(stray);
    await expect(
      createVault(deps, stray.replace('vault-', '').replaceAll('-', ' ')),
    ).rejects.toThrowError(/already has a database/);
    await client.deleteDatabase(stray);
  });
});
