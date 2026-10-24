import { describe, expect, it, vi } from 'vitest';
import type { CouchClient } from '../couch/client.js';
import { HealthMonitor } from './health.js';
import type { FetchLike } from './publicUrlProbe.js';

function fakeCouch(behavior: () => Promise<{ version: string }>): CouchClient {
  const settings: Record<string, string> = {
    'chttpd/require_valid_user': 'true',
    'httpd/WWW-Authenticate': 'Basic realm="couchdb"',
    'chttpd/enable_cors': 'true',
    'chttpd/max_http_request_size': '4294967296',
    'couchdb/max_document_size': '50000000',
    'cors/credentials': 'true',
    'cors/origins': 'app://obsidian.md,capacitor://localhost,http://localhost',
  };
  return {
    serverInfo: behavior,
    membershipNode: () => Promise.resolve('node'),
    listDatabases: () => Promise.resolve(['_users', '_replicator']),
    getConfig: (_node: string, section: string, key: string) =>
      Promise.resolve(settings[`${section}/${key}`]),
  } as unknown as CouchClient;
}

const goodProxy: FetchLike = (_url, init) =>
  Promise.resolve({
    status: 401,
    headers: {
      get: (name: string) =>
        ({
          server: 'CouchDB/3.5.0',
          'access-control-allow-origin': init.headers.Origin!,
          'access-control-allow-credentials': 'true',
        })[name.toLowerCase()] ?? null,
    },
  });

describe('HealthMonitor', () => {
  it('starts unknown before the first poll', () => {
    const monitor = new HealthMonitor(
      fakeCouch(() => Promise.resolve({ version: '3.5.0' })),
      {
        publicUrl: 'https://couchdb.example.com',
      },
    );
    expect(monitor.snapshot()).toEqual({
      status: 'unknown',
      couchdb: { reachable: false },
      config: { status: 'unknown', checkedAt: null },
      publicUrl: { status: 'unknown', url: 'https://couchdb.example.com', checkedAt: null },
      checkedAt: null,
    });
  });

  it('caches a successful poll, including the devices-URL probe', async () => {
    const monitor = new HealthMonitor(
      fakeCouch(() => Promise.resolve({ version: '3.5.0' })),
      {
        publicUrl: 'https://couchdb.example.com',
        fetchImpl: goodProxy,
      },
    );
    await monitor.poll();
    const snap = monitor.snapshot();
    expect(snap.status).toBe('ok');
    expect(snap.couchdb).toMatchObject({ reachable: true, version: '3.5.0' });
    expect(snap.config.status).toBe('ok');
    expect(snap.publicUrl).toMatchObject({ status: 'ok', server: 'CouchDB/3.5.0' });
    expect(snap.checkedAt).not.toBeNull();
  });

  it('picks the config rules from the CouchDB version', async () => {
    // Modern keys only on a 3.1 server: the legacy ones are required there.
    const monitor = new HealthMonitor(fakeCouch(() => Promise.resolve({ version: '3.1.2' })));
    await monitor.poll();
    expect(monitor.snapshot().config.status).toBe('drifted');
  });

  it('keeps the devices-URL probe separate from the admin connection', async () => {
    const broken: FetchLike = () => Promise.resolve({ status: 301, headers: { get: () => null } });
    const monitor = new HealthMonitor(
      fakeCouch(() => Promise.resolve({ version: '3.5.0' })),
      {
        publicUrl: 'https://couchdb.example.com',
        fetchImpl: broken,
      },
    );
    await monitor.poll();
    const snap = monitor.snapshot();
    // A redirecting proxy breaks every device, but the liveness probe stays green.
    expect(snap.status).toBe('ok');
    expect(snap.config.status).toBe('ok');
    expect(snap.publicUrl.status).toBe('fail');
  });

  it('still probes the devices URL when the admin URL is down', async () => {
    const fetchImpl = vi.fn(goodProxy);
    const monitor = new HealthMonitor(
      fakeCouch(() => Promise.reject(new Error('down'))),
      {
        publicUrl: 'https://couchdb.example.com',
        fetchImpl,
      },
    );
    await monitor.poll();
    expect(monitor.snapshot().status).toBe('degraded');
    expect(monitor.snapshot().publicUrl.status).toBe('ok');
    expect(fetchImpl).toHaveBeenCalled();
  });

  it('reports the probe as unknown when no public URL is configured', async () => {
    const monitor = new HealthMonitor(fakeCouch(() => Promise.resolve({ version: '3.5.0' })));
    await monitor.poll();
    expect(monitor.snapshot().publicUrl).toMatchObject({
      status: 'unknown',
      error: expect.stringMatching(/COUCHDB_PUBLIC_URL/) as string,
    });
  });

  it('degrades when CouchDB is unreachable, keeping the error readable', async () => {
    const monitor = new HealthMonitor(
      fakeCouch(() => Promise.reject(new Error('CouchDB is unreachable (GET /): timeout'))),
    );
    await monitor.poll();
    const snap = monitor.snapshot();
    expect(snap.status).toBe('degraded');
    expect(snap.couchdb.reachable).toBe(false);
    expect(snap.couchdb.error).toMatch(/unreachable/);
  });

  it('recovers on the next successful poll', async () => {
    let fail = true;
    const monitor = new HealthMonitor(
      fakeCouch(() =>
        fail ? Promise.reject(new Error('down')) : Promise.resolve({ version: '3.5.0' }),
      ),
    );
    await monitor.poll();
    expect(monitor.snapshot().status).toBe('degraded');
    fail = false;
    await monitor.poll();
    expect(monitor.snapshot().status).toBe('ok');
  });
});
