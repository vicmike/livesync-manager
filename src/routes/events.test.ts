import { describe, expect, it } from 'vitest';
import { recordEvent } from '../services/events.js';
import { asCouchClient, FakeCouch, makeTestServer } from '../testing.js';

async function makeFixture() {
  const server = await makeTestServer({ couch: asCouchClient(new FakeCouch()) });
  const setup = await server.inject({
    method: 'POST',
    url: '/api/v1/auth/setup',
    payload: { password: 'a-long-enough-password' },
  });
  const cookie = `lsc_session=${setup.cookies.find((c) => c.name === 'lsc_session')!.value}`;
  return { server, cookie };
}

describe('events feed', () => {
  it('requires a session', async () => {
    const { server } = await makeFixture();
    const res = await server.inject({ method: 'GET', url: '/api/v1/events' });
    expect(res.statusCode).toBe(401);
    await server.close();
  });

  it('returns newest first with level and vault filters', async () => {
    const { server, cookie } = await makeFixture();
    recordEvent(server.db, { level: 'warn', actor: 'system', message: 'B', vaultId: 'v1' });
    recordEvent(server.db, { level: 'info', actor: 'admin', message: 'C', vaultId: 'v2' });

    const all = await server.inject({ method: 'GET', url: '/api/v1/events', headers: { cookie } });
    const messages = (all.json() as { message: string }[]).map((e) => e.message);
    // 'Admin password set' from setup is present too, oldest.
    expect(messages[0]).toBe('C');
    expect(messages).toContain('Admin password set');

    const warns = await server.inject({
      method: 'GET',
      url: '/api/v1/events?level=warn',
      headers: { cookie },
    });
    expect((warns.json() as { message: string }[]).map((e) => e.message)).toEqual(['B']);

    const v2 = await server.inject({
      method: 'GET',
      url: '/api/v1/events?vaultId=v2',
      headers: { cookie },
    });
    expect((v2.json() as { message: string }[]).map((e) => e.message)).toEqual(['C']);

    const limited = await server.inject({
      method: 'GET',
      url: '/api/v1/events?limit=1',
      headers: { cookie },
    });
    expect(limited.json()).toHaveLength(1);
    await server.close();
  });
});
