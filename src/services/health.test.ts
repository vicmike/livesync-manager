import { describe, expect, it } from 'vitest';
import type { CouchClient } from '../couch/client.js';
import { HealthMonitor } from './health.js';

function fakeCouch(behavior: () => Promise<{ version: string }>): CouchClient {
  return { serverInfo: behavior } as unknown as CouchClient;
}

describe('HealthMonitor', () => {
  it('starts unknown before the first poll', () => {
    const monitor = new HealthMonitor(fakeCouch(() => Promise.resolve({ version: '3.5.0' })));
    expect(monitor.snapshot()).toEqual({
      status: 'unknown',
      couchdb: { reachable: false },
      checkedAt: null,
    });
  });

  it('caches a successful poll', async () => {
    const monitor = new HealthMonitor(fakeCouch(() => Promise.resolve({ version: '3.5.0' })));
    await monitor.poll();
    const snap = monitor.snapshot();
    expect(snap.status).toBe('ok');
    expect(snap.couchdb).toMatchObject({ reachable: true, version: '3.5.0' });
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
