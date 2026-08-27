import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { decryptSetupUri } from '../crypto/setupUri.js';
import { openDatabase } from '../db/index.js';
import { defaultMigrationsDir, runMigrations } from '../db/migrations.js';
import { FakeCouch, insertTestDevice, makeTestConfig } from '../testing.js';
import {
  consumeInvite,
  createInvite,
  findInvite,
  generateInvitePassphrase,
  type InviteDeps,
} from './invites.js';
import { createVault } from './vaults.js';

async function makeFixture() {
  const db = openDatabase(':memory:');
  runMigrations(db, defaultMigrationsDir());
  const masterKey = randomBytes(32);
  const config = makeTestConfig();
  const vault = await createVault({ db, couch: new FakeCouch(), masterKey }, 'Personal');
  const device = insertTestDevice(db, masterKey, vault.id, 'Phone');
  const deps: InviteDeps = { db, masterKey, config };
  return { deps, vault, device };
}

function tokenFrom(url: string): string {
  return url.split('/invite/')[1]!;
}

describe('generateInvitePassphrase', () => {
  it('is human-typeable: word-word-number', () => {
    for (let i = 0; i < 20; i++) {
      expect(generateInvitePassphrase()).toMatch(/^[a-z]+-[a-z]+-\d{2}$/);
    }
  });
});

describe('createInvite', () => {
  it('stores only hashes and ciphertexts, and the URI decrypts to a working conf', async () => {
    const { deps, vault, device } = await makeFixture();
    const invite = await createInvite(deps, {
      vaultId: vault.id,
      deviceId: device.id,
      couchUsername: device.couchUsername,
      couchPassword: 'device-secret-pw',
    });
    expect(invite.url).toBe(`https://livesync.example.com/invite/${tokenFrom(invite.url)}`);
    expect(invite.urlQr).toContain('<svg');

    const row = deps.db.prepare('SELECT * FROM invites').get() as {
      token_hash: string;
      setup_uri_enc: Buffer;
      uri_passphrase_enc: Buffer;
    };
    expect(row.token_hash).not.toContain(tokenFrom(invite.url));
    expect(row.setup_uri_enc.toString('latin1')).not.toContain('device-secret-pw');

    const page = findInvite(deps, tokenFrom(invite.url))!;
    const conf = await decryptSetupUri(page.setupUri, invite.uriPassphrase);
    expect(conf).toMatchObject({
      couchDB_URI: 'https://couchdb.example.com',
      couchDB_USER: device.couchUsername,
      couchDB_PASSWORD: 'device-secret-pw',
      couchDB_DBNAME: 'vault-personal',
      isConfigured: true,
      encrypt: true,
      usePathObfuscation: true,
      syncOnStart: true,
      periodicReplication: true,
      syncOnFileOpen: true,
      batchSave: true,
      settingVersion: 10,
      chunkSplitterVersion: 'v3-rabin-karp',
      E2EEAlgorithm: 'v2',
      syncAfterMerge: false,
    });
    expect(conf.activeConfigurationId).toBe('livesync-manager-couchdb');
    expect(conf.remoteConfigurations).toEqual({
      'livesync-manager-couchdb': expect.objectContaining({
        id: 'livesync-manager-couchdb',
        name: 'LiveSync Manager CouchDB',
        isEncrypted: false,
        uri: expect.stringContaining('couchdb.example.com'),
      }),
    });
    // Removed upstream in 1.0; must not resurface in minted URIs.
    expect(conf).not.toHaveProperty('doNotUseFixedRevisionForChunks');
    expect(conf.passphrase).toBe(vault.e2eePassphrase);
  });

  it("replaces a device's previous pending invite", async () => {
    const { deps, vault, device } = await makeFixture();
    const first = await createInvite(deps, {
      vaultId: vault.id,
      deviceId: device.id,
      couchUsername: device.couchUsername,
      couchPassword: 'pw',
    });
    const second = await createInvite(deps, {
      vaultId: vault.id,
      deviceId: device.id,
      couchUsername: device.couchUsername,
      couchPassword: 'pw',
    });
    expect(findInvite(deps, tokenFrom(first.url))).toBeUndefined();
    expect(findInvite(deps, tokenFrom(second.url))).toBeDefined();
    expect(deps.db.prepare('SELECT count(*) c FROM invites').get()).toEqual({ c: 1 });
  });

  it('clamps the TTL to a day', async () => {
    const { deps, vault, device } = await makeFixture();
    const invite = await createInvite(deps, {
      vaultId: vault.id,
      deviceId: device.id,
      couchUsername: device.couchUsername,
      couchPassword: 'pw',
      ttlMinutes: 999999,
    });
    const hours = (new Date(invite.expiresAt).getTime() - Date.now()) / 3_600_000;
    expect(hours).toBeLessThanOrEqual(24.01);
  });
});

describe('findInvite / consumeInvite', () => {
  it('is single-use and hides expired invites', async () => {
    const { deps, vault, device } = await makeFixture();
    const invite = await createInvite(deps, {
      vaultId: vault.id,
      deviceId: device.id,
      couchUsername: device.couchUsername,
      couchPassword: 'pw',
    });
    const token = tokenFrom(invite.url);

    expect(findInvite(deps, 'unknown-token')).toBeUndefined();
    expect(consumeInvite(deps, token)).toBe(true);
    expect(findInvite(deps, token)).toBeUndefined();
    expect(consumeInvite(deps, token)).toBe(false);

    const again = await createInvite(deps, {
      vaultId: vault.id,
      deviceId: device.id,
      couchUsername: device.couchUsername,
      couchPassword: 'pw',
    });
    deps.db
      .prepare('UPDATE invites SET expires_at = ? WHERE used_at IS NULL')
      .run(new Date(0).toISOString());
    expect(findInvite(deps, tokenFrom(again.url))).toBeUndefined();
  });
});

describe('unencrypted vaults', () => {
  it('mints a URI without a passphrase and with encrypt disabled', async () => {
    const db = openDatabase(':memory:');
    runMigrations(db, defaultMigrationsDir());
    const masterKey = randomBytes(32);
    const config = makeTestConfig();
    const vault = await createVault({ db, couch: new FakeCouch(), masterKey }, 'Plain', {
      encrypted: false,
    });
    const device = insertTestDevice(db, masterKey, vault.id, 'Phone');
    const deps: InviteDeps = { db, masterKey, config };
    const invite = await createInvite(deps, {
      vaultId: vault.id,
      deviceId: device.id,
      couchUsername: device.couchUsername,
      couchPassword: 'pw',
    });
    const page = findInvite(deps, tokenFrom(invite.url))!;
    const conf = await decryptSetupUri(page.setupUri, invite.uriPassphrase);
    expect(conf.encrypt).toBe(false);
    expect(conf.usePathObfuscation).toBe(false);
    expect('passphrase' in conf).toBe(false);
  });
});
