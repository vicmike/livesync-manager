import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { decryptSecret } from '../crypto/index.js';
import { openDatabase } from '../db/index.js';
import { defaultMigrationsDir, runMigrations } from '../db/migrations.js';
import { FakeCouch } from '../testing.js';
import {
  adoptVault,
  createVault,
  deleteVault,
  deleteVaultConsequences,
  getVault,
  getVaultDetail,
  listAdoptableDatabases,
  listVaults,
  removeLegacyMember,
  renameVault,
  setVaultArchived,
  setVaultLocked,
  slugify,
  type VaultServiceDeps,
} from './vaults.js';

function makeDeps(): VaultServiceDeps & { fake: FakeCouch } {
  const db = openDatabase(':memory:');
  runMigrations(db, defaultMigrationsDir());
  const fake = new FakeCouch();
  return { db, couch: fake, masterKey: randomBytes(32), fake };
}

describe('slugify', () => {
  it('produces couchdb-safe slugs', () => {
    expect(slugify('Personal Notes')).toBe('personal-notes');
    expect(slugify('  Ümläuts & Co!  ')).toBe('umlauts-co');
    expect(slugify('a'.repeat(80))).toHaveLength(40);
  });

  it('rejects names with no usable characters', () => {
    expect(() => slugify('!!!')).toThrowError(/at least one letter or digit/);
  });
});

describe('createVault', () => {
  it('creates the database, sentinel security, encrypted passphrase, and event', async () => {
    const deps = makeDeps();
    const vault = await createVault(deps, 'Personal');
    expect(vault.couchDbName).toBe('vault-personal');
    expect(vault.e2eePassphrase).toHaveLength(32);

    expect(deps.fake.databases.has('vault-personal')).toBe(true);
    const security = await deps.fake.getSecurity('vault-personal');
    expect(security.members?.roles).toEqual(['_admin']);
    // Stamped like upstream provisioning, so plugin 1.0.6+ sees a valid
    // empty remote instead of an unreadable one.
    expect(deps.fake.databases.get('vault-personal')!.docs.has('obsydian_livesync_version')).toBe(
      true,
    );

    const row = deps.db
      .prepare('SELECT e2ee_passphrase_enc, settings_json FROM vaults WHERE id = ?')
      .get(vault.id) as { e2ee_passphrase_enc: Buffer; settings_json: string };
    expect(row.e2ee_passphrase_enc.toString('latin1')).not.toContain(vault.e2eePassphrase);
    expect(
      decryptSecret(deps.masterKey, row.e2ee_passphrase_enc, {
        table: 'vaults',
        column: 'e2ee_passphrase_enc',
        rowId: vault.id,
      }),
    ).toBe(vault.e2eePassphrase);
    expect(JSON.parse(row.settings_json)).toMatchObject({ encrypt: true, settingVersion: 10 });

    const events = deps.db.prepare('SELECT message FROM events').all() as { message: string }[];
    expect(events.map((e) => e.message)).toContain('Created vault Personal');
  });

  it('rejects duplicate slugs', async () => {
    const deps = makeDeps();
    await createVault(deps, 'Personal');
    await expect(createVault(deps, 'personal!')).rejects.toThrowError(/already exists/);
  });

  it('never adopts an existing CouchDB database', async () => {
    const deps = makeDeps();
    await deps.fake.createDatabase('vault-personal');
    await expect(createVault(deps, 'Personal')).rejects.toThrowError(/already has a database/);
    expect(deps.db.prepare('SELECT count(*) c FROM vaults').get()).toEqual({ c: 0 });
  });

  it('rolls back the CouchDB database when a later step fails', async () => {
    const deps = makeDeps();
    deps.fake.setSecurity = () => Promise.reject(new Error('boom'));
    await expect(createVault(deps, 'Personal')).rejects.toThrowError('boom');
    expect(deps.fake.databases.has('vault-personal')).toBe(false);
    expect(deps.db.prepare('SELECT count(*) c FROM vaults').get()).toEqual({ c: 0 });
  });
});

describe('lifecycle', () => {
  it('lists active vaults, hiding archived unless asked', async () => {
    const deps = makeDeps();
    const a = await createVault(deps, 'Alpha');
    await createVault(deps, 'Beta');
    setVaultArchived(deps.db, a.id, true);
    expect(listVaults(deps.db, false).map((v) => v.name)).toEqual(['Beta']);
    expect(listVaults(deps.db, true).map((v) => v.name)).toEqual(['Alpha', 'Beta']);
  });

  it('renames and archives with events, unarchive restores', async () => {
    const deps = makeDeps();
    const vault = await createVault(deps, 'Alpha');
    expect(renameVault(deps.db, vault.id, 'Alpha Two').name).toBe('Alpha Two');
    const archived = setVaultArchived(deps.db, vault.id, true);
    expect(archived.status).toBe('archived');
    expect(archived.archivedAt).not.toBeNull();
    const restored = setVaultArchived(deps.db, vault.id, false);
    expect(restored.status).toBe('active');
    expect(restored.archivedAt).toBeNull();
    const messages = (
      deps.db.prepare('SELECT message FROM events').all() as { message: string }[]
    ).map((e) => e.message);
    expect(messages).toContain('Renamed vault Alpha to Alpha Two');
    expect(messages).toContain('Archived vault Alpha Two');
    expect(messages).toContain('Unarchived vault Alpha Two');
  });
});

describe('deleteVault', () => {
  it('spells out the consequences', async () => {
    const deps = makeDeps();
    const vault = await createVault(deps, 'Doomed');
    const consequences = await deleteVaultConsequences(deps, vault.id);
    expect(consequences.join('\n')).toMatch(/vault-doomed .* will be permanently deleted/);
    expect(consequences.join('\n')).toMatch(/final snapshot .* left on CouchDB/);
  });

  it('removes the CouchDB database and all metadata rows', async () => {
    const deps = makeDeps();
    const vault = await createVault(deps, 'Doomed');
    await deleteVault(deps, vault.id);
    expect(deps.fake.databases.has('vault-doomed')).toBe(false);
    expect(deps.db.prepare('SELECT count(*) c FROM vaults').get()).toEqual({ c: 0 });
    const messages = (
      deps.db.prepare('SELECT message FROM events').all() as { message: string }[]
    ).map((e) => e.message);
    expect(messages).toContain('Deleted vault Doomed and its database vault-doomed');
  });

  it('tolerates an already-missing CouchDB database', async () => {
    const deps = makeDeps();
    const vault = await createVault(deps, 'Doomed');
    await deps.fake.deleteDatabase('vault-doomed');
    await deleteVault(deps, vault.id);
    expect(deps.db.prepare('SELECT count(*) c FROM vaults').get()).toEqual({ c: 0 });
  });
});

describe('optional encryption', () => {
  it('creates an unencrypted vault with no passphrase and a plaintext template', async () => {
    const deps = makeDeps();
    const vault = await createVault(deps, 'Plain', { encrypted: false });
    expect(vault.encrypted).toBe(false);
    expect(vault.e2eePassphrase).toBeUndefined();
    const row = deps.db
      .prepare('SELECT e2ee_passphrase_enc, settings_json FROM vaults WHERE id = ?')
      .get(vault.id) as { e2ee_passphrase_enc: Buffer; settings_json: string };
    expect(row.e2ee_passphrase_enc.length).toBe(0);
    expect(JSON.parse(row.settings_json)).toMatchObject({
      encrypt: false,
      usePathObfuscation: false,
    });
  });
});

describe('lock and unlock', () => {
  it('swaps to the sentinel and back to device members', async () => {
    const deps = makeDeps();
    const vault = await createVault(deps, 'Guarded');
    deps.db
      .prepare(
        `INSERT INTO devices (id, vault_id, name, couch_username, couch_password_enc, status, created_at)
         VALUES ('d1', ?, 'Phone', 'vault-guarded.phone.abc123', x'00', 'active', ?)`,
      )
      .run(vault.id, new Date().toISOString());
    await deps.fake.setSecurity('vault-guarded', {
      admins: { names: [], roles: [] },
      members: { names: ['vault-guarded.phone.abc123'], roles: ['_admin'] },
    });

    const locked = await setVaultLocked(deps, vault.id, true);
    expect(locked.locked).toBe(true);
    expect((await deps.fake.getSecurity('vault-guarded')).members?.names).toEqual([]);

    const unlocked = await setVaultLocked(deps, vault.id, false);
    expect(unlocked.locked).toBe(false);
    expect((await deps.fake.getSecurity('vault-guarded')).members?.names).toEqual([
      'vault-guarded.phone.abc123',
    ]);
  });
});

describe('adoptVault', () => {
  it('adopts an existing database without touching its security', async () => {
    const deps = makeDeps();
    await deps.fake.createDatabase('obsidian');
    await deps.fake.putDocument('obsidian', 'note-1');
    await deps.fake.setSecurity('obsidian', {
      members: { names: ['legacy-shared-user'], roles: [] },
    });

    const vault = await adoptVault(deps, {
      name: 'Old Vault',
      couchDbName: 'obsidian',
      encrypted: true,
      e2eePassphrase: 'the-existing-passphrase',
    });
    expect(vault.couchDbName).toBe('obsidian');
    expect(vault.docCount).toBe(1);
    expect((await deps.fake.getSecurity('obsidian')).members?.names).toEqual([
      'legacy-shared-user',
    ]);

    const detail = await getVaultDetail(deps, vault.id);
    expect(detail.legacyMembers).toEqual(['legacy-shared-user']);
  });

  it('requires the passphrase for encrypted adoption and a real database', async () => {
    const deps = makeDeps();
    await deps.fake.createDatabase('obsidian');
    await expect(
      adoptVault(deps, { name: 'Old', couchDbName: 'obsidian', encrypted: true }),
    ).rejects.toThrowError(/passphrase is required/);
    await expect(
      adoptVault(deps, {
        name: 'Old',
        couchDbName: 'missing-db',
        encrypted: false,
      }),
    ).rejects.toThrowError(/no database named/);
  });

  it('refuses databases already managed by a vault', async () => {
    const deps = makeDeps();
    await createVault(deps, 'Personal');
    await expect(
      adoptVault(deps, { name: 'Dup', couchDbName: 'vault-personal', encrypted: false }),
    ).rejects.toThrowError(/already managed/);
  });

  it('lists adoption candidates, excluding managed, backup, and system dbs', async () => {
    const deps = makeDeps();
    await createVault(deps, 'Personal');
    await deps.fake.createDatabase('obsidian');
    await deps.fake.createDatabase('bk-vault-personal-20260101000000');
    await deps.fake.createDatabase('_users');
    const adoptable = await listAdoptableDatabases(deps);
    expect(adoptable.map((a) => a.name)).toEqual(['obsidian']);
  });
});

describe('removeLegacyMember', () => {
  it('removes exactly the named member', async () => {
    const deps = makeDeps();
    await deps.fake.createDatabase('obsidian');
    const vault = await adoptVault(deps, {
      name: 'Old',
      couchDbName: 'obsidian',
      encrypted: false,
    });
    await deps.fake.setSecurity('obsidian', {
      members: { names: ['legacy-a', 'legacy-b'], roles: [] },
    });
    await removeLegacyMember(deps, vault.id, 'legacy-a');
    expect((await deps.fake.getSecurity('obsidian')).members?.names).toEqual(['legacy-b']);
    await expect(removeLegacyMember(deps, vault.id, 'legacy-a')).rejects.toThrowError(
      /not a member/,
    );
    expect(getVault(deps.db, vault.id).encrypted).toBe(false);
  });
});
