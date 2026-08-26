import { describe, expect, it } from 'vitest';
import type { CouchClient } from '../couch/client.js';
import { HealthMonitor } from './health.js';

function fakeCouch(behavior: () => Promise<{ version: string }>): CouchClient {
  const settings: Record<string, string> = {
    'chttpd/require_valid_user': 'true',
    'chttpd_auth/require_valid_user': 'true',
    'httpd/WWW-Authenticate': 'Basic realm="couchdb"',
    'httpd/enable_cors': 'true',
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

describe('HealthMonitor', () => {
  it('starts unknown before the first poll', () => {
    const monitor = new HealthMonitor(fakeCouch(() => Promise.resolve({ version: '3.5.0' })));
    expect(monitor.snapshot()).toEqual({
      status: 'unknown',
      couchdb: { reachable: false },
      config: { status: 'unknown', checkedAt: null },
      checkedAt: null,
    });
  });

  it('caches a successful poll', async () => {
    const monitor = new HealthMonitor(fakeCouch(() => Promise.resolve({ version: '3.5.0' })));
    await monitor.poll();
    const snap = monitor.snapshot();
    expect(snap.status).toBe('ok');
    expect(snap.couchdb).toMatchObject({ reachable: true, version: '3.5.0' });
    expect(snap.config.status).toBe('ok');
    expect(snap.checkedAt).not.toBeNull();
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
