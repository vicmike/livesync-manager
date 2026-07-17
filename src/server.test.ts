import { describe, expect, it } from 'vitest';
import { makeTestServer } from './testing.js';

describe('server', () => {
  it('answers the health probe from cache without touching CouchDB', async () => {
    const server = await makeTestServer();
    const res = await server.inject({ method: 'GET', url: '/api/v1/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      status: 'unknown',
      couchdb: { reachable: false },
      checkedAt: null,
    });
    await server.close();
  });

  it('404s unknown API routes as JSON', async () => {
    const server = await makeTestServer();
    const res = await server.inject({ method: 'GET', url: '/api/v1/nope' });
    expect(res.statusCode).toBe(404);
    await server.close();
  });
});
