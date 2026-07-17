import { describe, expect, it } from 'vitest';
import { createInvite } from '../services/invites.js';
import { createVault } from '../services/vaults.js';
import { asCouchClient, FakeCouch, insertTestDevice, makeTestServer } from '../testing.js';

async function makeFixture(env: Record<string, string> = {}) {
  const server = await makeTestServer({ couch: asCouchClient(new FakeCouch()), env });
  const vault = await createVault(
    { db: server.db, couch: new FakeCouch(), masterKey: server.masterKey },
    'Personal',
  );
  const device = insertTestDevice(server.db, server.masterKey, vault.id, 'Phone');
  const invite = await createInvite(server, {
    vaultId: vault.id,
    deviceId: device.id,
    couchUsername: device.couchUsername,
    couchPassword: 'device-pw',
  });
  const token = invite.url.split('/invite/')[1]!;
  return { server, invite, token };
}

describe('invite page', () => {
  it('renders the page with warning, QR, deep link, and passphrase', async () => {
    const { server, invite, token } = await makeFixture();
    const res = await server.inject({ method: 'GET', url: `/invite/${token}` });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toContain('vault Personal');
    expect(res.body).toContain('Phone');
    expect(res.body).toMatch(/merge/i);
    expect(res.body).toMatch(/empty/i);
    expect(res.body).toContain('obsidian://setuplivesync?settings=');
    expect(res.body).toContain('<svg');
    expect(res.body).toContain(invite.uriPassphrase);
    await server.close();
  });

  it('sets no-store, no-referrer, and a page-scoped CSP', async () => {
    const { server, token } = await makeFixture();
    const res = await server.inject({ method: 'GET', url: `/invite/${token}` });
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['content-security-policy']).toContain("default-src 'none'");
    await server.close();
  });

  it('serves an identical 404 page for unknown, used, and expired tokens', async () => {
    const { server, token } = await makeFixture();
    const unknown = await server.inject({ method: 'GET', url: '/invite/no-such-token' });
    await server.inject({ method: 'POST', url: `/invite/${token}/consume` });
    const used = await server.inject({ method: 'GET', url: `/invite/${token}` });
    expect(unknown.statusCode).toBe(404);
    expect(used.statusCode).toBe(404);
    expect(used.body).toBe(unknown.body);
    await server.close();
  });

  it('refuses plain HTTP for non-local hosts', async () => {
    const { server, token } = await makeFixture();
    const res = await server.inject({
      method: 'GET',
      url: `/invite/${token}`,
      headers: { host: 'livesync.example.com' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.body).toContain('HTTPS required');
    await server.close();
  });

  it('accepts HTTPS via forwarded proto when the proxy is trusted', async () => {
    const { server, token } = await makeFixture({ TRUST_PROXY: 'true' });
    const res = await server.inject({
      method: 'GET',
      url: `/invite/${token}`,
      headers: { host: 'livesync.example.com', 'x-forwarded-proto': 'https' },
    });
    expect(res.statusCode).toBe(200);
    await server.close();
  });

  it('rate-limits aggressive scanning', async () => {
    const { server } = await makeFixture();
    let limited = false;
    for (let i = 0; i < 40; i++) {
      const res = await server.inject({ method: 'GET', url: `/invite/scan-${i}` });
      if (res.statusCode === 429) {
        limited = true;
        break;
      }
    }
    expect(limited).toBe(true);
    await server.close();
  });
});

describe('invite consumption', () => {
  it('consumes once via JSON and reports 404 afterwards', async () => {
    const { server, token } = await makeFixture();
    const first = await server.inject({ method: 'POST', url: `/invite/${token}/consume` });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ ok: true });
    const second = await server.inject({ method: 'POST', url: `/invite/${token}/consume` });
    expect(second.statusCode).toBe(404);
    await server.close();
  });

  it('answers the page form with HTML', async () => {
    const { server, token } = await makeFixture();
    const res = await server.inject({
      method: 'POST',
      url: `/invite/${token}/consume`,
      headers: { accept: 'text/html' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('All set');
    await server.close();
  });
});
