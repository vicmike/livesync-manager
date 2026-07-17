// Device lifecycle against a real CouchDB: proves a device user can read
// its own vault database and loses access on revocation. Uses throwaway
// vault-lsc-int-* databases; requires require_valid_user to be OFF or ON.
// Device access is asserted via authenticated requests either way.
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CouchClient } from '../couch/client.js';
import { openDatabase } from '../db/index.js';
import { defaultMigrationsDir, runMigrations } from '../db/migrations.js';
import { makeTestConfig } from '../testing.js';
import { addDevice, revokeDevice, type DeviceServiceDeps } from './devices.js';
import { createVault, deleteVault, type VaultServiceDeps } from './vaults.js';

const url = process.env.COUCHDB_TEST_URL ?? 'http://127.0.0.1:5984';
const user = process.env.COUCHDB_TEST_USER ?? 'admin';
const password = process.env.COUCHDB_TEST_PASSWORD ?? 'admin';

const admin = new CouchClient({ url, user, password });
const db = openDatabase(':memory:');
const masterKey = randomBytes(32);
const vaultDeps: VaultServiceDeps = { db, couch: admin, masterKey };
const deviceDeps: DeviceServiceDeps = { db, couch: admin, masterKey, config: makeTestConfig() };

async function deviceCanRead(username: string, devicePassword: string, dbName: string) {
  const asDevice = new CouchClient({ url, user: username, password: devicePassword });
  try {
    await asDevice.databaseInfo(dbName);
    return true;
  } catch {
    return false;
  }
}

beforeAll(async () => {
  runMigrations(db, defaultMigrationsDir());
  const deadline = Date.now() + 90_000;
  for (;;) {
    try {
      await admin.up();
      break;
    } catch (err) {
      if (Date.now() > deadline) {
        throw new Error('No CouchDB reachable for integration tests', { cause: err });
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  if (!(await admin.listDatabases()).includes('_users')) {
    await admin.createDatabase('_users');
  }
}, 120_000);

afterAll(async () => {
  for (const name of await admin.listDatabases()) {
    if (name.startsWith('vault-lsc-int-')) {
      await admin.deleteDatabase(name).catch(() => {});
    }
  }
});

describe('per-device access on a real CouchDB', () => {
  it('grants exactly the vault database, and revocation cuts it off', async () => {
    const vault = await createVault(vaultDeps, `lsc int m6 ${Date.now()}`);
    const other = await createVault(vaultDeps, `lsc int m6 other ${Date.now()}`);
    const { device } = await addDevice(deviceDeps, vault.id, { name: 'Int Phone' });

    // The invite's password lives encrypted; decrypt path is covered by unit
    // tests. Here we rotate to a known value through the same API instead.
    const known = 'integration-device-password';
    await admin.putUser(device.couchUsername, known);

    expect(await deviceCanRead(device.couchUsername, known, vault.couchDbName)).toBe(true);
    expect(await deviceCanRead(device.couchUsername, known, other.couchDbName)).toBe(false);

    await revokeDevice(deviceDeps, device.id);
    expect(await deviceCanRead(device.couchUsername, known, vault.couchDbName)).toBe(false);

    await deleteVault(vaultDeps, vault.id);
    await deleteVault(vaultDeps, other.id);
  });
});
