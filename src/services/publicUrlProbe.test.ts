import { describe, expect, it, vi } from 'vitest';
import { probePublicUrl, type FetchLike, type ProbeResponse } from './publicUrlProbe.js';
import { REQUIRED_CORS_ORIGINS } from './serverConfig.js';

function response(status: number, headers: Record<string, string>): ProbeResponse {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return { status, headers: { get: (name) => lower[name.toLowerCase()] ?? null } };
}

/** A CouchDB that echoes the origin and allows credentials, like a correct proxy. */
function goodCouch(status = 401): FetchLike {
  return (_url, init) =>
    Promise.resolve(
      response(status, {
        Server: 'CouchDB/3.3.3 (Erlang OTP/25)',
        'Access-Control-Allow-Origin': init.headers.Origin!,
        'Access-Control-Allow-Credentials': 'true',
      }),
    );
}

describe('probePublicUrl', () => {
  it('passes a correctly proxied https CouchDB, reporting the server banner', async () => {
    const fetchImpl = vi.fn(goodCouch());
    const probe = await probePublicUrl('https://couchdb.example.com', { fetchImpl });
    expect(probe.status).toBe('ok');
    expect(probe.problems).toEqual([]);
    expect(probe.server).toBe('CouchDB/3.3.3 (Erlang OTP/25)');
    expect(probe.origins.map((o) => o.origin)).toEqual(REQUIRED_CORS_ORIGINS);
    expect(probe.origins.every((o) => o.ok)).toBe(true);
    // Unauthenticated, never following redirects, one request per origin.
    expect(fetchImpl).toHaveBeenCalledTimes(REQUIRED_CORS_ORIGINS.length);
    for (const call of fetchImpl.mock.calls) {
      expect(call[0]).toBe('https://couchdb.example.com/');
      expect(call[1].redirect).toBe('manual');
      expect(Object.keys(call[1].headers).map((h) => h.toLowerCase())).not.toContain(
        'authorization',
      );
    }
  });

  it('fails on a redirect, which clients cannot follow', async () => {
    const fetchImpl: FetchLike = () =>
      Promise.resolve(response(301, { Location: 'https://couchdb.example.com/couchdb/' }));
    const probe = await probePublicUrl('https://couchdb.example.com', { fetchImpl });
    expect(probe.status).toBe('fail');
    expect(probe.origins[0]!.httpStatus).toBe(301);
    expect(probe.origins[0]!.problems[0]).toMatch(/redirect/);
    expect(probe.origins[0]!.problems[0]).toContain('to https://couchdb.example.com/couchdb/');
    expect(probe.problems.at(-1)).toMatch(/3 of 3 LiveSync origins/);
  });

  it('fails when the allow-origin header is missing', async () => {
    // CouchDB answered (its banner is present), so the missing header is a
    // real CORS defect, not an access layer refusing the manager.
    const fetchImpl: FetchLike = () =>
      Promise.resolve(
        response(401, { Server: 'CouchDB/3.3.3', 'Access-Control-Allow-Credentials': 'true' }),
      );
    const probe = await probePublicUrl('https://couchdb.example.com', { fetchImpl });
    expect(probe.status).toBe('fail');
    expect(probe.origins[0]!.problems).toHaveLength(1);
    expect(probe.origins[0]!.problems[0]).toMatch(/No Access-Control-Allow-Origin/);
    expect(probe.origins[0]!.problems[0]).toMatch(/cors\/origins/);
  });

  it('fails when the allow-origin header does not echo the origin (wildcard or proxy-set)', async () => {
    const fetchImpl: FetchLike = () =>
      Promise.resolve(
        response(401, {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Credentials': 'true',
        }),
      );
    const probe = await probePublicUrl('https://couchdb.example.com', { fetchImpl });
    expect(probe.status).toBe('fail');
    expect(probe.origins[0]!.allowOrigin).toBe('*');
    expect(probe.origins[0]!.problems[0]).toMatch(/is "\*" for Origin app:\/\/obsidian\.md/);
  });

  it('fails when credentials are not allowed', async () => {
    const fetchImpl: FetchLike = (_url, init) =>
      Promise.resolve(response(401, { 'Access-Control-Allow-Origin': init.headers.Origin! }));
    const probe = await probePublicUrl('https://couchdb.example.com', { fetchImpl });
    expect(probe.status).toBe('fail');
    expect(probe.origins[0]!.problems[0]).toMatch(/Access-Control-Allow-Credentials is missing/);
    expect(probe.origins[0]!.problems[0]).toMatch(/cors\/credentials = true/);
  });

  it('reports a 403 without CORS headers as inconclusive, not as a CORS failure', async () => {
    // An IP allowlist or WAF in front of CouchDB refuses the manager's own
    // address; CouchDB never saw the request (it would have sent CORS headers
    // even on its 401), so nothing can be said about what devices see.
    const result = await probePublicUrl('https://couch.example.com', {
      fetchImpl: () => Promise.resolve(response(403, { Server: 'nginx' })),
    });
    expect(result.status).toBe('warn');
    expect(result.origins.every((o) => o.blocked === true && !o.ok)).toBe(true);
    expect(result.problems.join(' ')).toMatch(/inconclusive/);
    expect(result.origins[0]!.problems.join(' ')).toMatch(/allowlist|WAF/);
  });

  it('still fails when CouchDB itself answers 401 without CORS headers', async () => {
    const result = await probePublicUrl('https://couch.example.com', {
      fetchImpl: () => Promise.resolve(response(401, { Server: 'CouchDB/3.5.2 (Erlang OTP/26)' })),
    });
    expect(result.status).toBe('fail');
    expect(result.origins[0]!.blocked).toBeUndefined();
  });

  it('fails on a 5xx from the proxy', async () => {
    const fetchImpl: FetchLike = () => Promise.resolve(response(502, {}));
    const probe = await probePublicUrl('https://couchdb.example.com', { fetchImpl });
    expect(probe.status).toBe('fail');
    expect(probe.origins[0]!.problems[0]).toMatch(/HTTP 502/);
  });

  it('fails when the URL cannot be reached, naming the cause', async () => {
    const fetchImpl: FetchLike = () =>
      Promise.reject(Object.assign(new Error('fetch failed'), { cause: new Error('ENOTFOUND') }));
    const probe = await probePublicUrl('https://couchdb.example.com', { fetchImpl });
    expect(probe.status).toBe('fail');
    expect(probe.server).toBeNull();
    expect(probe.origins[0]!.httpStatus).toBeNull();
    expect(probe.origins[0]!.problems[0]).toMatch(/Could not reach .*ENOTFOUND/);
  });

  it('warns about plain http, distinguishing local addresses', async () => {
    const lan = await probePublicUrl('http://192.168.1.10:5984', { fetchImpl: goodCouch(200) });
    expect(lan.status).toBe('warn');
    expect(lan.scheme).toBe('http');
    expect(lan.problems).toHaveLength(1);
    expect(lan.problems[0]).toMatch(/local or private address/);
    expect(lan.problems[0]).toMatch(/iOS and Android/);

    const internet = await probePublicUrl('http://couchdb.example.com', {
      fetchImpl: goodCouch(200),
    });
    expect(internet.status).toBe('warn');
    expect(internet.problems[0]).toMatch(/unencrypted/);
  });

  it('reports a CORS failure as fail even when the scheme also warns', async () => {
    const fetchImpl: FetchLike = () => Promise.resolve(response(401, { Server: 'CouchDB/3.3.3' }));
    const probe = await probePublicUrl('http://localhost:5984', { fetchImpl });
    expect(probe.status).toBe('fail');
    expect(probe.problems).toHaveLength(2);
  });
});
