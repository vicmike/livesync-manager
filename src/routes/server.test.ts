import { describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { CouchError, type CouchClient } from '../couch/client.js';
import { makeTestServer } from '../testing.js';

function stubCouch(initial: Record<string, string>): CouchClient {
  const store = new Map(Object.entries(initial));
  const databases = ['_users', '_replicator'];
  return {
    membershipNode: () => Promise.resolve('_local'),
    getConfig: (_n: string, s: string, k: string) => Promise.resolve(store.get(`${s}/${k}`)),
    setConfig: (_n: string, s: string, k: string, v: string) => {
      store.set(`${s}/${k}`, v);
      return Promise.resolve();
    },
    listDatabases: () => Promise.resolve([...databases]),
    createDatabase: (name: string) => {
      databases.push(name);
      return Promise.resolve();
    },
  } as unknown as CouchClient;
}

async function login(server: FastifyInstance): Promise<string> {
  const res = await server.inject({
    method: 'POST',
    url: '/api/v1/auth/setup',
    payload: { password: 'a-long-enough-password' },
  });
  const cookie = res.cookies.find((c) => c.name === 'lsc_session')!;
  return `lsc_session=${cookie.value}`;
}

describe('server config routes', () => {
  it('requires a session', async () => {
    const server = await makeTestServer({ couch: stubCouch({}) });
    const res = await server.inject({ method: 'GET', url: '/api/v1/server/config' });
    expect(res.statusCode).toBe(401);
    await server.close();
  });

  it('reports failing checks and fixes them with a persistence caveat', async () => {
    const server = await makeTestServer({ couch: stubCouch({}) });
    const cookie = await login(server);

    const check = await server.inject({
      method: 'GET',
      url: '/api/v1/server/config',
      headers: { cookie },
    });
    expect(check.statusCode).toBe(200);
    expect(check.json().ok).toBe(false);

    const fix = await server.inject({
      method: 'POST',
      url: '/api/v1/server/config/fix',
      headers: { cookie },
    });
    expect(fix.statusCode).toBe(200);
    const body = fix.json();
    expect(body.recheck.ok).toBe(true);
    expect(body.persistence).toBe('unknown');
    expect(body.note).toMatch(/may not survive a CouchDB restart/);

    const events = server.db
      .prepare("SELECT message FROM events WHERE message LIKE '%configuration fix%'")
      .all();
    expect(events).toHaveLength(1);
    await server.close();
  });

  it('surfaces CouchDB failures as actionable 502s, not generic 500s', async () => {
    const broken = {
      membershipNode: () =>
        Promise.reject(new CouchError('CouchDB GET /_membership failed: 401 unauthorized', 401)),
    } as unknown as CouchClient;
    const server = await makeTestServer({ couch: broken });
    const cookie = await login(server);
    const res = await server.inject({
      method: 'GET',
      url: '/api/v1/server/config',
      headers: { cookie },
    });
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toMatch(/_membership failed: 401/);
    await server.close();
  });
});
