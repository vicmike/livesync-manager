import { describe, expect, it } from 'vitest';
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
  return { server, fake, cookie, vault };
}

describe('device routes', () => {
  it('requires a session', async () => {
    const { server, vault } = await makeFixture();
    const res = await server.inject({ method: 'GET', url: `/api/v1/vaults/${vault.id}/devices` });
    expect(res.statusCode).toBe(401);
    await server.close();
  });

  it('adds a device and returns the invite; the public page serves it', async () => {
    const { server, cookie, vault } = await makeFixture();
    const res = await server.inject({
      method: 'POST',
      url: `/api/v1/vaults/${vault.id}/devices`,
      headers: { cookie },
      payload: { name: 'Phone', platform: 'ios' },
    });
    expect(res.statusCode).toBe(201);
    const { device, invite } = res.json() as {
      device: { id: string; status: string };
      invite: { url: string; uriPassphrase: string };
    };
    expect(device.status).toBe('pending');

    const token = invite.url.split('/invite/')[1]!;
    const page = await server.inject({ method: 'GET', url: `/invite/${token}` });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('Phone');
    expect(page.body).toContain(invite.uriPassphrase);

    // Consuming the invite activates the device.
    await server.inject({ method: 'POST', url: `/invite/${token}/consume` });
    const list = await server.inject({
      method: 'GET',
      url: `/api/v1/vaults/${vault.id}/devices`,
      headers: { cookie },
    });
    expect((list.json() as { status: string }[])[0]!.status).toBe('active');
    await server.close();
  });

  it('reinvites with rotation and revokes behind a confirm token', async () => {
    const { server, fake, cookie, vault } = await makeFixture();
    const added = await server.inject({
      method: 'POST',
      url: `/api/v1/vaults/${vault.id}/devices`,
      headers: { cookie },
      payload: { name: 'Phone' },
    });
    const { device } = added.json() as { device: { id: string; couchUsername: string } };

    const reinvite = await server.inject({
      method: 'POST',
      url: `/api/v1/devices/${device.id}/reinvite`,
      headers: { cookie },
    });
    expect(reinvite.statusCode).toBe(200);
    expect((reinvite.json() as { invite: { url: string } }).invite.url).toContain('/invite/');

    const dry = await server.inject({
      method: 'POST',
      url: `/api/v1/devices/${device.id}/revoke?dryRun=1`,
      headers: { cookie },
    });
    expect(dry.statusCode).toBe(200);
    const { confirmToken, consequences } = dry.json() as {
      confirmToken: string;
      consequences: string[];
    };
    expect(consequences.join(' ')).toMatch(/stops syncing/);

    const noToken = await server.inject({
      method: 'POST',
      url: `/api/v1/devices/${device.id}/revoke`,
      headers: { cookie },
      payload: { confirmToken: 'bogus' },
    });
    expect(noToken.statusCode).toBe(409);

    const revoked = await server.inject({
      method: 'POST',
      url: `/api/v1/devices/${device.id}/revoke`,
      headers: { cookie },
      payload: { confirmToken },
    });
    expect(revoked.statusCode).toBe(200);
    expect((revoked.json() as { status: string }).status).toBe('revoked');
    expect(fake.users.has(device.couchUsername)).toBe(false);

    const again = await server.inject({
      method: 'POST',
      url: `/api/v1/devices/${device.id}/revoke?dryRun=1`,
      headers: { cookie },
    });
    expect(again.statusCode).toBe(409);
    await server.close();
  });

  it('renames a device', async () => {
    const { server, cookie, vault } = await makeFixture();
    const added = await server.inject({
      method: 'POST',
      url: `/api/v1/vaults/${vault.id}/devices`,
      headers: { cookie },
      payload: { name: 'Phone' },
    });
    const { device } = added.json() as { device: { id: string } };
    const renamed = await server.inject({
      method: 'PATCH',
      url: `/api/v1/devices/${device.id}`,
      headers: { cookie },
      payload: { name: 'Backup Phone' },
    });
    expect((renamed.json() as { name: string }).name).toBe('Backup Phone');
    await server.close();
  });

  it('lists LiveSync clients and links them to devices', async () => {
    const { server, fake, cookie, vault } = await makeFixture();
    const added = await server.inject({
      method: 'POST',
      url: `/api/v1/vaults/${vault.id}/devices`,
      headers: { cookie },
      payload: { name: 'Phone' },
    });
    const { device } = added.json() as { device: { id: string } };

    const empty = await server.inject({
      method: 'GET',
      url: `/api/v1/vaults/${vault.id}/nodes`,
      headers: { cookie },
    });
    expect(empty.statusCode).toBe(200);
    expect(empty.json()).toMatchObject({ milestone: 'absent', nodes: [] });

    fake.databases.get('vault-personal')!.localDocs.set('_local/obsydian_livesync_milestone', {
      type: 'milestoneinfo',
      accepted_nodes: ['node-1'],
      node_info: {
        'node-1': {
          device_name: 'My Phone',
          plugin_version: '1.0.39',
          last_connected: 1_700_000_000_000,
        },
      },
    });
    const listed = await server.inject({
      method: 'GET',
      url: `/api/v1/vaults/${vault.id}/nodes`,
      headers: { cookie },
    });
    const body = listed.json() as {
      milestone: string;
      nodes: { nodeId: string; label: string; device: { id: string } | null }[];
    };
    expect(body.milestone).toBe('present');
    // The device is still pending (never confirmed), so nothing auto-linked.
    expect(body.nodes).toEqual([
      expect.objectContaining({ nodeId: 'node-1', label: 'My Phone', device: null }),
    ]);

    const badBody = await server.inject({
      method: 'PUT',
      url: `/api/v1/devices/${device.id}/node`,
      headers: { cookie },
      payload: { nodeId: 42 },
    });
    expect(badBody.statusCode).toBe(400);

    const unknown = await server.inject({
      method: 'PUT',
      url: `/api/v1/devices/${device.id}/node`,
      headers: { cookie },
      payload: { nodeId: 'node-does-not-exist' },
    });
    expect(unknown.statusCode).toBe(404);

    const linked = await server.inject({
      method: 'PUT',
      url: `/api/v1/devices/${device.id}/node`,
      headers: { cookie },
      payload: { nodeId: 'node-1' },
    });
    expect(linked.statusCode).toBe(200);
    expect((linked.json() as { lastSeen: string }).lastSeen).toBe(
      new Date(1_700_000_000_000).toISOString(),
    );

    const health = await server.inject({
      method: 'GET',
      url: `/api/v1/vaults/${vault.id}/health`,
      headers: { cookie },
    });
    expect((health.json() as { clients: { total: number } }).clients.total).toBe(1);

    const unlinked = await server.inject({
      method: 'PUT',
      url: `/api/v1/devices/${device.id}/node`,
      headers: { cookie },
      payload: { nodeId: null },
    });
    expect(unlinked.statusCode).toBe(200);
    const after = await server.inject({
      method: 'GET',
      url: `/api/v1/vaults/${vault.id}/nodes`,
      headers: { cookie },
    });
    expect((after.json() as typeof body).nodes[0]!.device).toBeNull();
    await server.close();
  });
});
