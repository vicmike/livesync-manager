import { describe, expect, it } from 'vitest';
import { CouchClient, CouchError } from './client.js';

interface Call {
  url: string;
  init: RequestInit;
}

function makeClient(responses: Record<string, { status: number; body: unknown }>) {
  const calls: Call[] = [];
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init! });
    const key = `${init?.method} ${new URL(String(url)).pathname}`;
    const match = responses[key];
    if (!match) {
      throw new Error(`unexpected request ${key}`);
    }
    return new Response(JSON.stringify(match.body), {
      status: match.status,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  const client = new CouchClient({
    url: 'http://couch.internal:5984/',
    user: 'admin',
    password: 'hunter2-secret',
    fetchFn,
  });
  return { client, calls };
}

describe('CouchClient', () => {
  it('sends basic auth and JSON headers', async () => {
    const { client, calls } = makeClient({
      'GET /': { status: 200, body: { version: '3.5.0' } },
    });
    const info = await client.serverInfo();
    expect(info.version).toBe('3.5.0');
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.authorization).toBe(
      'Basic ' + Buffer.from('admin:hunter2-secret').toString('base64'),
    );
  });

  it('keeps credentials and host out of error messages', async () => {
    const { client } = makeClient({
      'GET /_all_dbs': { status: 401, body: { error: 'unauthorized', reason: 'nope' } },
    });
    const err = await client.listDatabases().catch((e: unknown) => e as CouchError);
    expect(err).toBeInstanceOf(CouchError);
    expect((err as CouchError).status).toBe(401);
    expect((err as CouchError).message).toBe('CouchDB GET /_all_dbs failed: 401 nope');
    expect((err as CouchError).message).not.toContain('hunter2');
    expect((err as CouchError).message).not.toContain('couch.internal');
  });

  it('reports unreachable servers distinctly', async () => {
    const client = new CouchClient({
      url: 'http://127.0.0.1:1',
      user: 'admin',
      password: 'pw',
      fetchFn: (() => Promise.reject(new Error('connect ECONNREFUSED'))) as typeof fetch,
    });
    await expect(client.serverInfo()).rejects.toThrowError(/CouchDB is unreachable \(GET \/\)/);
  });

  it('returns undefined for missing config keys', async () => {
    const { client } = makeClient({
      'GET /_node/x/_config/cors/origins': {
        status: 404,
        body: { error: 'not_found' },
      },
    });
    expect(await client.getConfig('x', 'cors', 'origins')).toBeUndefined();
  });

  it('discovers the node from _membership, falling back to _local', async () => {
    const { client } = makeClient({
      'GET /_membership': { status: 200, body: { all_nodes: ['couchdb@127.0.0.1'] } },
    });
    expect(await client.membershipNode()).toBe('couchdb@127.0.0.1');

    const { client: empty } = makeClient({
      'GET /_membership': { status: 200, body: { all_nodes: [] } },
    });
    expect(await empty.membershipNode()).toBe('_local');
  });

  it('updates an existing user with its _rev', async () => {
    const id = 'org.couchdb.user:tablet';
    const { client, calls } = makeClient({
      [`GET /_users/${encodeURIComponent(id)}`]: {
        status: 200,
        body: { _id: id, _rev: '3-abc', type: 'user', name: 'tablet', roles: [] },
      },
      [`PUT /_users/${encodeURIComponent(id)}`]: { status: 201, body: { ok: true } },
    });
    await client.putUser('tablet', 'new-password');
    const putBody = JSON.parse(calls[1]!.init.body as string) as Record<string, unknown>;
    expect(putBody._rev).toBe('3-abc');
    expect(putBody.password).toBe('new-password');
  });
});
