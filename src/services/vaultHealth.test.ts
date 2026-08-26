import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { openDatabase } from '../db/index.js';
import { defaultMigrationsDir, runMigrations } from '../db/migrations.js';
import { FakeCouch, makeTestConfig } from '../testing.js';
import { addDevice, markDeviceConnected, type DeviceServiceDeps } from './devices.js';
import { getVaultHealth } from './vaultHealth.js';
import { createVault } from './vaults.js';

async function fixture() {
  const db = openDatabase(':memory:');
  runMigrations(db, defaultMigrationsDir());
  const couch = new FakeCouch();
  const masterKey = randomBytes(32);
  const vault = await createVault({ db, couch, masterKey }, 'Personal');
  const deps: DeviceServiceDeps = { db, couch, masterKey, config: makeTestConfig() };
  const { device } = await addDevice(deps, vault.id, { name: 'Phone' });
  markDeviceConnected(db, device.id);
  return { db, couch, vault, device };
}

describe('vault health', () => {
  it('reports configured device access without claiming live sync activity', async () => {
    const { db, couch, vault, device } = await fixture();
    const health = await getVaultHealth({ db, couch }, vault.id);

    expect(health.devices).toEqual([
      expect.objectContaining({
        id: device.id,
        name: 'Phone',
        status: 'active',
        access: 'configured',
        firstConnected: expect.any(String),
      }),
    ]);
    expect(health.warnings.join('\n')).not.toContain('Device Phone');
  });

  it('warns when a managed device account or vault membership drifts', async () => {
    const { db, couch, vault, device } = await fixture();
    couch.users.delete(device.couchUsername);
    await couch.setSecurity('vault-personal', {
      admins: { names: [], roles: [] },
      members: { names: [], roles: ['_admin'] },
    });

    const health = await getVaultHealth({ db, couch }, vault.id);
    expect(health.devices[0]).toMatchObject({ access: 'drifted' });
    expect(health.warnings.join('\n')).toContain('account and vault access are missing');
    expect(health.warnings.join('\n')).toContain('Reinvite it');
  });

  it('keeps access unknown when CouchDB cannot be checked', async () => {
    const { db, couch, vault } = await fixture();
    couch.getSecurity = () => Promise.reject(new Error('timeout'));

    const health = await getVaultHealth({ db, couch }, vault.id);
    expect(health.devices[0]).toMatchObject({ access: 'unknown' });
    expect(health.warnings.join('\n')).toContain('Could not verify device access (timeout)');
  });
});
