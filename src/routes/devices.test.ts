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
});
