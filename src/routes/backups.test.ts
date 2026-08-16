import { describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { asCouchClient, FakeCouch, makeTestServer } from '../testing.js';

async function makeFixture() {
  const fake = new FakeCouch();
  const server = await makeTestServer({ couch: asCouchClient(fake) });
  const setup = await server.inject({
    method: 'POST',
    url: '/api/v1/auth/setup',
    payload: { password: 'a-long-enough-password' },
  });
  const cookie = `lsc_session=${setup.cookies.find((c) => c.name === 'lsc_session')!.value}`;
  const vaultRes = await server.inject({
    method: 'POST',
    url: '/api/v1/vaults',
    headers: { cookie },
    payload: { name: 'Personal' },
  });
  const vault = vaultRes.json() as { id: string };
  await fake.putDocument('vault-personal', 'note-1');
  await fake.putDocument('vault-personal', 'note-2');
  return { server, fake, cookie, vault };
}

async function waitForSettled(
  server: FastifyInstance,
  cookie: string,
  vaultId: string,
): Promise<{ id: string; status: string; location: string }> {
  for (let i = 0; i < 50; i++) {
    const res = await server.inject({
      method: 'GET',
      url: `/api/v1/vaults/${vaultId}/backups`,
      headers: { cookie },
    });
    const [backup] = res.json() as { id: string; status: string; location: string }[];
    if (backup && backup.status !== 'running') {
      return backup;
    }
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('backup never settled');
}

describe('backup routes', () => {
  it('requires a session', async () => {
    const { server, vault } = await makeFixture();
    const res = await server.inject({ method: 'GET', url: `/api/v1/vaults/${vault.id}/backups` });
    expect(res.statusCode).toBe(401);
    await server.close();
  });

  it('triggers a manual backup asynchronously and settles verified', async () => {
    const { server, cookie, vault } = await makeFixture();
    const res = await server.inject({
      method: 'POST',
      url: `/api/v1/vaults/${vault.id}/backups`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(202);
    expect((res.json() as { status: string }).status).toBe('running');

    const settled = await waitForSettled(server, cookie, vault.id);
    expect(settled.status).toBe('verified');

    const dup = await server.inject({
      method: 'POST',
      url: `/api/v1/vaults/${vault.id}/backups`,
      headers: { cookie },
    });
    expect(dup.statusCode).toBe(202); // previous one settled, so a new run starts
    await waitForSettled(server, cookie, vault.id);
    await server.close();
  });

  it('re-verifies on demand and deletes behind a confirm token', async () => {
    const { server, fake, cookie, vault } = await makeFixture();
    await server.inject({
      method: 'POST',
      url: `/api/v1/vaults/${vault.id}/backups`,
      headers: { cookie },
    });
    const backup = await waitForSettled(server, cookie, vault.id);

    const verify = await server.inject({
      method: 'POST',
      url: `/api/v1/backups/${backup.id}/verify`,
      headers: { cookie },
    });
    expect(verify.statusCode).toBe(200);

    const dry = await server.inject({
      method: 'DELETE',
      url: `/api/v1/backups/${backup.id}?dryRun=1`,
      headers: { cookie },
    });
    const { confirmToken, consequences } = dry.json() as {
      confirmToken: string;
      consequences: string[];
    };
    expect(consequences.join(' ')).toContain(backup.location);

    const del = await server.inject({
      method: 'DELETE',
      url: `/api/v1/backups/${backup.id}`,
      headers: { cookie },
      payload: { confirmToken },
    });
    expect(del.statusCode).toBe(200);
    expect(fake.databases.has(backup.location)).toBe(false);
    await server.close();
  });

  it('reports backup freshness in vault health', async () => {
    const { server, cookie, vault } = await makeFixture();
    const before = await server.inject({
      method: 'GET',
      url: `/api/v1/vaults/${vault.id}/health`,
      headers: { cookie },
    });
    expect((before.json() as { warnings: string[] }).warnings.join(' ')).toMatch(
      /never been backed up/,
    );

    await server.inject({
      method: 'POST',
      url: `/api/v1/vaults/${vault.id}/backups`,
      headers: { cookie },
    });
    await waitForSettled(server, cookie, vault.id);
    const after = await server.inject({
      method: 'GET',
      url: `/api/v1/vaults/${vault.id}/health`,
      headers: { cookie },
    });
    const health = after.json() as {
      warnings: string[];
      backup: { lastVerifiedAt: string | null };
    };
    expect(health.warnings).toEqual([]);
    expect(health.backup.lastVerifiedAt).not.toBeNull();
    await server.close();
  });
});

describe('restore over HTTP', () => {
  it('previews, restores non-destructively, and swaps behind a confirm token', async () => {
    const { server, fake, cookie, vault } = await makeFixture();
    await server.inject({
      method: 'POST',
      url: `/api/v1/vaults/${vault.id}/backups`,
      headers: { cookie },
    });
    const backup = await waitForSettled(server, cookie, vault.id);

    const preview = await server.inject({
      method: 'GET',
      url: `/api/v1/backups/${backup.id}/restore/preview`,
      headers: { cookie },
    });
    expect(preview.statusCode).toBe(200);
    expect((preview.json() as { docCount: number }).docCount).toBe(3);

    const restore = await server.inject({
      method: 'POST',
      url: `/api/v1/backups/${backup.id}/restore`,
      headers: { cookie },
    });
    const { restoredDbName } = restore.json() as { restoredDbName: string };
    expect(fake.databases.has(restoredDbName)).toBe(true);

    await fake.putDocument('vault-personal', 'doomed-note');
    const dry = await server.inject({
      method: 'POST',
      url: `/api/v1/backups/${backup.id}/restore/swap?dryRun=1`,
      headers: { cookie },
    });
    expect((dry.json() as { consequences: string[] }).consequences.join(' ')).toMatch(
      /fetch the vault/,
    );
    const swap = await server.inject({
      method: 'POST',
      url: `/api/v1/backups/${backup.id}/restore/swap`,
      headers: { cookie },
      payload: { confirmToken: dry.json().confirmToken },
    });
    expect(swap.statusCode).toBe(200);
    const result = swap.json() as { docCount: number; preSwapBackup: string };
    expect(result.docCount).toBe(3);
    expect(fake.databases.get('vault-personal')!.docCount).toBe(3);
    expect(fake.databases.get(result.preSwapBackup)!.docCount).toBe(4);
    await server.close();
  });
});
