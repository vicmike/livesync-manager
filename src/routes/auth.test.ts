import { describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { makeTestServer } from '../testing.js';

const PASSWORD = 'a-long-enough-password';

function makeServer(): Promise<FastifyInstance> {
  return makeTestServer();
}

function sessionCookie(res: { cookies: { name: string; value: string }[] }): string {
  const cookie = res.cookies.find((c) => c.name === 'lsc_session');
  expect(cookie).toBeDefined();
  return `lsc_session=${cookie!.value}`;
}

async function setUp(server: FastifyInstance) {
  const res = await server.inject({
    method: 'POST',
    url: '/api/v1/auth/setup',
    payload: { password: PASSWORD },
  });
  expect(res.statusCode).toBe(201);
  return res;
}

describe('first-boot setup', () => {
  it('reports setupRequired until the password is set, then authenticates', async () => {
    const server = await makeServer();
    let session = await server.inject({ method: 'GET', url: '/api/v1/auth/session' });
    expect(session.json()).toMatchObject({ setupRequired: true, authenticated: false });

    const res = await setUp(server);
    const cookie = sessionCookie(res);

    session = await server.inject({
      method: 'GET',
      url: '/api/v1/auth/session',
      headers: { cookie },
    });
    expect(session.json()).toMatchObject({ setupRequired: false, authenticated: true });
    await server.close();
  });

  it('sets secure cookie flags', async () => {
    const server = await makeServer();
    const res = await setUp(server);
    const header = res.headers['set-cookie'] as string;
    expect(header).toMatch(/HttpOnly/i);
    expect(header).toMatch(/Secure/i);
    expect(header).toMatch(/SameSite=Lax/i);
    expect(header).toMatch(/Path=\//);
    await server.close();
  });

  it('refuses setup twice', async () => {
    const server = await makeServer();
    await setUp(server);
    const again = await server.inject({
      method: 'POST',
      url: '/api/v1/auth/setup',
      payload: { password: 'another-long-password' },
    });
    expect(again.statusCode).toBe(409);
    await server.close();
  });

  it('rejects a short password with an actionable error', async () => {
    const server = await makeServer();
    const res = await server.inject({
      method: 'POST',
      url: '/api/v1/auth/setup',
      payload: { password: 'short' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/at least 12 characters/);
    await server.close();
  });
});

describe('login and logout', () => {
  it('rejects login before setup, pointing at setup', async () => {
    const server = await makeServer();
    const res = await server.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { password: PASSWORD },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toMatch(/setup/);
    await server.close();
  });

  it('logs in with the right password and out again', async () => {
    const server = await makeServer();
    await setUp(server);

    const bad = await server.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { password: 'not-the-password' },
    });
    expect(bad.statusCode).toBe(401);

    const good = await server.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { password: PASSWORD },
    });
    expect(good.statusCode).toBe(200);
    const cookie = sessionCookie(good);

    const out = await server.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: { cookie },
    });
    expect(out.statusCode).toBe(200);

    const after = await server.inject({
      method: 'GET',
      url: '/api/v1/auth/session',
      headers: { cookie },
    });
    expect(after.json()).toMatchObject({ authenticated: false });
    await server.close();
  });

  it('throttles repeated failures per IP', async () => {
    const server = await makeServer();
    await setUp(server);
    for (let i = 0; i < 10; i++) {
      const res = await server.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { password: 'not-the-password' },
      });
      expect(res.statusCode).toBe(401);
    }
    const blocked = await server.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { password: PASSWORD },
    });
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json().error).toMatch(/Too many attempts/);
    await server.close();
  });

  it('writes audit events without secret material', async () => {
    const server = await makeServer();
    await setUp(server);
    await server.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { password: 'not-the-password' },
    });
    const rows = server.db.prepare('SELECT message, detail_json FROM events ORDER BY ts').all() as {
      message: string;
      detail_json: string | null;
    }[];
    expect(rows.map((r) => r.message)).toEqual([
      'Admin password set',
      'Failed admin login attempt',
    ]);
    for (const row of rows) {
      expect(row.detail_json ?? '').not.toContain(PASSWORD);
      expect(row.detail_json ?? '').not.toContain('not-the-password');
    }
    await server.close();
  });
});

describe('password change', () => {
  it('requires a session, the current password, and the policy', async () => {
    const server = await makeServer();
    const cookie = sessionCookie(await setUp(server));

    const anonymous = await server.inject({
      method: 'POST',
      url: '/api/v1/auth/password',
      payload: { currentPassword: PASSWORD, newPassword: 'another-long-password' },
    });
    expect(anonymous.statusCode).toBe(401);

    const wrongCurrent = await server.inject({
      method: 'POST',
      url: '/api/v1/auth/password',
      headers: { cookie },
      payload: { currentPassword: 'not-the-password', newPassword: 'another-long-password' },
    });
    expect(wrongCurrent.statusCode).toBe(401);
    expect(wrongCurrent.json().error).toMatch(/Current password/);

    const tooShort = await server.inject({
      method: 'POST',
      url: '/api/v1/auth/password',
      headers: { cookie },
      payload: { currentPassword: PASSWORD, newPassword: 'short' },
    });
    expect(tooShort.statusCode).toBe(400);
    expect(tooShort.json().error).toMatch(/at least 12 characters/);
    await server.close();
  });

  it('changes the password and logs out every other session', async () => {
    const server = await makeServer();
    const cookie = sessionCookie(await setUp(server));
    const other = sessionCookie(
      await server.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { password: PASSWORD },
      }),
    );

    const res = await server.inject({
      method: 'POST',
      url: '/api/v1/auth/password',
      headers: { cookie },
      payload: { currentPassword: PASSWORD, newPassword: 'another-long-password' },
    });
    expect(res.statusCode).toBe(200);

    // Old password dead, new one works.
    const oldLogin = await server.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { password: PASSWORD },
    });
    expect(oldLogin.statusCode).toBe(401);
    const newLogin = await server.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { password: 'another-long-password' },
    });
    expect(newLogin.statusCode).toBe(200);

    // The changing session survives; the other one is gone.
    const mine = await server.inject({
      method: 'GET',
      url: '/api/v1/auth/session',
      headers: { cookie },
    });
    expect(mine.json()).toMatchObject({ authenticated: true });
    const theirs = await server.inject({
      method: 'GET',
      url: '/api/v1/auth/session',
      headers: { cookie: other },
    });
    expect(theirs.json()).toMatchObject({ authenticated: false });

    const messages = (
      server.db.prepare('SELECT message FROM events').all() as { message: string }[]
    ).map((r) => r.message);
    expect(messages).toContain('Admin password changed (other sessions logged out)');
    await server.close();
  });
});

describe('auth guard and headers', () => {
  it('ignores an invalid session cookie', async () => {
    const server = await makeServer();
    await setUp(server);
    const res = await server.inject({
      method: 'GET',
      url: '/api/v1/auth/session',
      headers: { cookie: 'lsc_session=forged-token' },
    });
    expect(res.json()).toMatchObject({ authenticated: false });
    const blocked = await server.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: { cookie: 'lsc_session=forged-token' },
    });
    expect(blocked.statusCode).toBe(401);
    await server.close();
  });

  it('leaves the health probe public', async () => {
    const server = await makeServer();
    const res = await server.inject({ method: 'GET', url: '/api/v1/health' });
    expect(res.statusCode).toBe(200);
    await server.close();
  });

  it('logout requires a session', async () => {
    const server = await makeServer();
    await setUp(server);
    const res = await server.inject({ method: 'POST', url: '/api/v1/auth/logout' });
    expect(res.statusCode).toBe(401);
    await server.close();
  });

  it('sets HSTS and a self-only CSP', async () => {
    const server = await makeServer();
    const res = await server.inject({ method: 'GET', url: '/api/v1/health' });
    expect(res.headers['strict-transport-security']).toBe('max-age=31536000');
    expect(res.headers['content-security-policy']).toContain("default-src 'self'");
    expect(res.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    await server.close();
  });
});
