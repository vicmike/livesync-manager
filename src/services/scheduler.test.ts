import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { openDatabase } from '../db/index.js';
import { defaultMigrationsDir, runMigrations } from '../db/migrations.js';
import { FakeCouch, makeTestConfig } from '../testing.js';
import { listBackups, type BackupServiceDeps } from './backups.js';
import { CouchError } from '../couch/client.js';
import { BackupScheduler } from './scheduler.js';
import { listVaultNodes, MILESTONE_DOC_ID } from './vaultNodes.js';
import { createVault, setVaultArchived } from './vaults.js';

async function makeFixture() {
  const db = openDatabase(':memory:');
  runMigrations(db, defaultMigrationsDir());
  const fake = new FakeCouch();
  const vault = await createVault({ db, couch: fake, masterKey: randomBytes(32) }, 'Personal');
  const deps: BackupServiceDeps = { db, couch: fake, config: makeTestConfig() };
  const errors: string[] = [];
  const scheduler = new BackupScheduler(deps, (err) => errors.push(err.message));
  return { deps, fake, vault, scheduler, errors };
}

describe('BackupScheduler', () => {
  it('backs up a vault with no recent backup, then leaves it alone', async () => {
    const { deps, vault, scheduler } = await makeFixture();
    expect(scheduler.due()).toEqual([vault.id]);
    await scheduler.tick();
    expect(listBackups(deps.db, vault.id)).toHaveLength(1);
    expect(listBackups(deps.db, vault.id)[0]!.kind).toBe('scheduled');
    expect(scheduler.due()).toEqual([]);
    await scheduler.tick();
    expect(listBackups(deps.db, vault.id)).toHaveLength(1);
  });

  it('considers a vault due again once its backup is a day old', async () => {
    const { vault, scheduler } = await makeFixture();
    await scheduler.tick();
    const dayAhead = new Date(Date.now() + 25 * 60 * 60 * 1000);
    expect(scheduler.due(dayAhead)).toEqual([vault.id]);
  });

  it('retries after a failed backup and reports the error', async () => {
    const { deps, fake, vault, scheduler, errors } = await makeFixture();
    fake.replicate = () => Promise.reject(new Error('replication exploded'));
    await scheduler.tick();
    expect(errors).toHaveLength(1);
    expect(scheduler.due()).toEqual([vault.id]); // failed backups don't count as fresh
    expect(listBackups(deps.db, vault.id)[0]!.status).toBe('failed');
  });

  it('skips archived vaults', async () => {
    const { deps, vault, scheduler } = await makeFixture();
    setVaultArchived(deps.db, vault.id, true);
    expect(scheduler.due()).toEqual([]);
    expect(scheduler.activeVaults()).toEqual([]);
  });

  it('refreshes LiveSync client observations for active vaults every tick', async () => {
    const { deps, fake, vault, scheduler, errors } = await makeFixture();
    fake.databases.get(vault.couchDbName)!.localDocs.set(MILESTONE_DOC_ID, {
      type: 'milestoneinfo',
      accepted_nodes: ['node-1'],
      node_info: {
        'node-1': { device_name: 'Phone', plugin_version: '1.0.39', last_connected: 5 },
      },
    });
    await scheduler.tick();
    expect(listVaultNodes(deps.db, vault.id)).toEqual([
      expect.objectContaining({ nodeId: 'node-1', label: 'Phone' }),
    ]);
    expect(errors).toEqual([]);

    fake.getLocalDoc = () => Promise.reject(new CouchError('CouchDB GET failed: 503', 503));
    await scheduler.tick();
    expect(errors.some((e) => e.includes('LiveSync client refresh failed'))).toBe(true);
    // Stored observations survive a failed refresh.
    expect(listVaultNodes(deps.db, vault.id)).toHaveLength(1);
  });
});
