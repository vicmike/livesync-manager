import { describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { asCouchClient, FakeCouch, makeTestServer } from '../testing.js';

async function makeServer(env: Record<string, string> = {}) {
  const fake = new FakeCouch();
  const server = await makeTestServer({ couch: asCouchClient(fake), env });
  const res = await server.inject({
    method: 'POST',
    url: '/api/v1/auth/setup',
    payload: { password: 'a-long-enough-password' },
  });
  const cookie = `lsc_session=${res.cookies.find((c) => c.name === 'lsc_session')!.value}`;
  return { server, fake, cookie };
}

async function createVault(server: FastifyInstance, cookie: string, name: string) {
  const res = await server.inject({
    method: 'POST',
    url: '/api/v1/vaults',
    headers: { cookie },
    payload: { name },
  });
  expect(res.statusCode).toBe(201);
  return res.json() as { id: string; name: string; e2eePassphrase: string };
}

describe('vault routes', () => {
  it('requires a session', async () => {
    const { server } = await makeServer();
    const res = await server.inject({ method: 'GET', url: '/api/v1/vaults' });
    expect(res.statusCode).toBe(401);
    await server.close();
  });

  it('creates a vault and returns the passphrase exactly once', async () => {
    const { server, cookie } = await makeServer();
    const vault = await createVault(server, cookie, 'Personal');
    expect(vault.e2eePassphrase).toHaveLength(32);

    const detail = await server.inject({
      method: 'GET',
      url: `/api/v1/vaults/${vault.id}`,
      headers: { cookie },
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.body).not.toContain(vault.e2eePassphrase);
    expect(detail.json()).toMatchObject({
      name: 'Personal',
      deviceCount: 0,
      lastBackup: null,
      couch: { docCount: 0 },
    });
    await server.close();
  });

  it('filters archived vaults from the default list', async () => {
    const { server, cookie } = await makeServer();
    const vault = await createVault(server, cookie, 'Old');
    await createVault(server, cookie, 'Current');
    const patch = await server.inject({
      method: 'PATCH',
      url: `/api/v1/vaults/${vault.id}`,
      headers: { cookie },
      payload: { archived: true },
    });
    expect(patch.json().status).toBe('archived');

    const active = await server.inject({
      method: 'GET',
      url: '/api/v1/vaults',
      headers: { cookie },
    });
    expect((active.json() as { name: string }[]).map((v) => v.name)).toEqual(['Current']);
    const all = await server.inject({
      method: 'GET',
      url: '/api/v1/vaults?archived=1',
      headers: { cookie },
    });
    expect((all.json() as { name: string }[]).map((v) => v.name)).toEqual(['Old', 'Current']);
    await server.close();
  });

  it('surfaces duplicate names as 409 with guidance', async () => {
    const { server, cookie } = await makeServer();
    await createVault(server, cookie, 'Personal');
    const res = await server.inject({
      method: 'POST',
      url: '/api/v1/vaults',
      headers: { cookie },
      payload: { name: 'personal' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/more distinct name/);
    await server.close();
  });
});

describe('vault deletion', () => {
  it('takes a final snapshot by default; backupFirst false skips it', async () => {
    const { server, fake, cookie } = await makeServer();
    const vault = await createVault(server, cookie, 'Keeper');
    const dry = await server.inject({
      method: 'DELETE',
      url: `/api/v1/vaults/${vault.id}?dryRun=1`,
      headers: { cookie },
    });
    expect((dry.json().consequences as string[]).join(' ')).toMatch(/final snapshot/);
    const res = await server.inject({
      method: 'DELETE',
      url: `/api/v1/vaults/${vault.id}`,
      headers: { cookie },
      payload: { confirmToken: dry.json().confirmToken, typedName: 'Keeper' },
    });
    expect(res.statusCode).toBe(200);
    expect(fake.databases.has('vault-keeper')).toBe(false);
    expect([...fake.databases.keys()].some((n) => n.startsWith('bk-vault-keeper-'))).toBe(true);

    const second = await createVault(server, cookie, 'Gone');
    const dry2 = await server.inject({
      method: 'DELETE',
      url: `/api/v1/vaults/${second.id}?dryRun=1`,
      headers: { cookie },
    });
    await server.inject({
      method: 'DELETE',
      url: `/api/v1/vaults/${second.id}`,
      headers: { cookie },
      payload: { confirmToken: dry2.json().confirmToken, typedName: 'Gone', backupFirst: false },
    });
    expect([...fake.databases.keys()].some((n) => n.startsWith('bk-vault-gone-'))).toBe(false);
    await server.close();
  });

  it('aborts deletion when the final snapshot fails', async () => {
    const { server, fake, cookie } = await makeServer();
    const vault = await createVault(server, cookie, 'Sticky');
    const dry = await server.inject({
      method: 'DELETE',
      url: `/api/v1/vaults/${vault.id}?dryRun=1`,
      headers: { cookie },
    });
    fake.replicate = () => Promise.reject(new Error('replication exploded'));
    const res = await server.inject({
      method: 'DELETE',
      url: `/api/v1/vaults/${vault.id}`,
      headers: { cookie },
      payload: { confirmToken: dry.json().confirmToken, typedName: 'Sticky' },
    });
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toMatch(/NOT deleted/);
    expect(fake.databases.has('vault-sticky')).toBe(true);
    await server.close();
  });

  it('walks the full confirm-token flow', async () => {
    const { server, fake, cookie } = await makeServer();
    const vault = await createVault(server, cookie, 'Doomed');

    const dry = await server.inject({
      method: 'DELETE',
      url: `/api/v1/vaults/${vault.id}?dryRun=1`,
      headers: { cookie },
    });
    expect(dry.statusCode).toBe(200);
    const { confirmToken, consequences } = dry.json() as {
      confirmToken: string;
      consequences: string[];
    };
    expect(consequences.join('\n')).toMatch(/permanently deleted/);

    // Without a token: rejected.
    const bare = await server.inject({
      method: 'DELETE',
      url: `/api/v1/vaults/${vault.id}`,
      headers: { cookie },
      payload: { confirmToken: 'bogus', typedName: 'Doomed' },
    });
    expect(bare.statusCode).toBe(409);

    // Wrong typed name: rejected, token survives.
    const typo = await server.inject({
      method: 'DELETE',
      url: `/api/v1/vaults/${vault.id}`,
      headers: { cookie },
      payload: { confirmToken, typedName: 'doomed' },
    });
    expect(typo.statusCode).toBe(400);

    const real = await server.inject({
      method: 'DELETE',
      url: `/api/v1/vaults/${vault.id}`,
      headers: { cookie },
      payload: { confirmToken, typedName: 'Doomed' },
    });
    expect(real.statusCode).toBe(200);
    expect(real.json()).toEqual({ deleted: true });
    expect(fake.databases.has('vault-doomed')).toBe(false);

    // The token is spent and the vault is gone.
    const again = await server.inject({
      method: 'DELETE',
      url: `/api/v1/vaults/${vault.id}`,
      headers: { cookie },
      payload: { confirmToken, typedName: 'Doomed' },
    });
    expect(again.statusCode).toBe(404);
    await server.close();
  });

  it('rejects a token issued for a different vault', async () => {
    const { server, cookie } = await makeServer();
    const a = await createVault(server, cookie, 'Alpha');
    const b = await createVault(server, cookie, 'Beta');
    const dry = await server.inject({
      method: 'DELETE',
      url: `/api/v1/vaults/${a.id}?dryRun=1`,
      headers: { cookie },
    });
    const res = await server.inject({
      method: 'DELETE',
      url: `/api/v1/vaults/${b.id}`,
      headers: { cookie },
      payload: { confirmToken: dry.json().confirmToken, typedName: 'Beta' },
    });
    expect(res.statusCode).toBe(409);
    await server.close();
  });
});

describe('lock, adopt, and legacy members over HTTP', () => {
  it('locks and unlocks a vault', async () => {
    const { server, fake, cookie } = await makeServer();
    const vault = await createVault(server, cookie, 'Guarded');
    const locked = await server.inject({
      method: 'POST',
      url: `/api/v1/vaults/${vault.id}/lock`,
      headers: { cookie },
    });
    expect((locked.json() as { locked: boolean }).locked).toBe(true);
    expect((await fake.getSecurity('vault-guarded')).members?.names).toEqual([]);
    const unlocked = await server.inject({
      method: 'POST',
      url: `/api/v1/vaults/${vault.id}/unlock`,
      headers: { cookie },
    });
    expect((unlocked.json() as { locked: boolean }).locked).toBe(false);
    await server.close();
  });

  it('adopts an unmanaged database and removes a legacy member behind a token', async () => {
    const { server, fake, cookie } = await makeServer();
    await fake.createDatabase('obsidian');
    await fake.putDocument('obsidian', 'note-1');
    await fake.setSecurity('obsidian', { members: { names: ['shared-user'], roles: [] } });

    const adoptable = await server.inject({
      method: 'GET',
      url: '/api/v1/vaults/adoptable',
      headers: { cookie },
    });
    expect((adoptable.json() as { name: string }[]).map((d) => d.name)).toContain('obsidian');

    const adopted = await server.inject({
      method: 'POST',
      url: '/api/v1/vaults/connect',
      headers: { cookie },
      payload: {
        name: 'Old Vault',
        couchDbName: 'obsidian',
        encrypted: true,
        e2eePassphrase: 'existing-passphrase',
      },
    });
    expect(adopted.statusCode).toBe(201);
    const vaultId = (adopted.json() as { id: string }).id;

    const detail = await server.inject({
      method: 'GET',
      url: `/api/v1/vaults/${vaultId}`,
      headers: { cookie },
    });
    expect((detail.json() as { legacyMembers: string[] }).legacyMembers).toEqual(['shared-user']);

    const dry = await server.inject({
      method: 'POST',
      url: `/api/v1/vaults/${vaultId}/members/remove?dryRun=1`,
      headers: { cookie },
      payload: { name: 'shared-user' },
    });
    expect((dry.json() as { consequences: string[] }).consequences.join(' ')).toMatch(
      /stops syncing/,
    );
    const removed = await server.inject({
      method: 'POST',
      url: `/api/v1/vaults/${vaultId}/members/remove`,
      headers: { cookie },
      payload: { name: 'shared-user', confirmToken: dry.json().confirmToken },
    });
    expect(removed.statusCode).toBe(200);
    expect((await fake.getSecurity('obsidian')).members?.names).toEqual([]);
    await server.close();
  });

  it('creates unencrypted vaults without returning a passphrase', async () => {
    const { server, cookie } = await makeServer();
    const res = await server.inject({
      method: 'POST',
      url: '/api/v1/vaults',
      headers: { cookie },
      payload: { name: 'Plain', encrypted: false },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { encrypted: boolean; e2eePassphrase?: string };
    expect(body.encrypted).toBe(false);
    expect(body.e2eePassphrase).toBeUndefined();
    await server.close();
  });
});
