import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { CouchError } from '../couch/client.js';
import { openDatabase } from '../db/index.js';
import { defaultMigrationsDir, runMigrations } from '../db/migrations.js';
import { FakeCouch, makeTestConfig } from '../testing.js';
import { addDevice, listDevices, markDeviceConnected, type DeviceServiceDeps } from './devices.js';
import {
  compareVersions,
  isOutdatedPlugin,
  isStaleNode,
  STALE_AFTER_DAYS,
  MILESTONE_DOC_ID,
  MIN_RECOMMENDED_PLUGIN_VERSION,
  projectMilestone,
  refreshVaultNodes,
  setDeviceNode,
} from './vaultNodes.js';
import { createVault } from './vaults.js';

const T0 = Date.parse('2026-10-20T10:00:00.000Z');

function nodeInfo(overrides: Record<string, unknown> = {}) {
  return {
    device_name: 'Phone',
    vault_name: 'Notes',
    app_version: '1.11.4',
    plugin_version: '1.0.39',
    last_connected: T0,
    progress: '42',
    ...overrides,
  };
}

/** A milestone document in the shape commonlib's ensureRemoteIsCompatible writes. */
function milestone(
  nodes: Record<string, Record<string, unknown>>,
  extra: Record<string, unknown> = {},
) {
  const ids = Object.keys(nodes);
  return {
    _id: MILESTONE_DOC_ID,
    type: 'milestoneinfo',
    created: T0,
    locked: false,
    accepted_nodes: ids,
    node_chunk_info: Object.fromEntries(ids.map((id) => [id, { min: 0, max: 0 }])),
    node_info: nodes,
    tweak_values: {
      PREFERRED: { encrypt: true },
      ...Object.fromEntries(ids.map((id) => [id, {}])),
    },
    ...extra,
  };
}

async function fixture() {
  const db = openDatabase(':memory:');
  runMigrations(db, defaultMigrationsDir());
  const couch = new FakeCouch();
  const masterKey = randomBytes(32);
  const vault = await createVault({ db, couch, masterKey }, 'Personal');
  const deviceDeps: DeviceServiceDeps = { db, couch, masterKey, config: makeTestConfig() };
  const setMilestone = (doc: Record<string, unknown>) =>
    couch.databases.get(vault.couchDbName)!.localDocs.set(MILESTONE_DOC_ID, doc);
  const events = () =>
    (db.prepare('SELECT message FROM events ORDER BY ts').all() as { message: string }[]).map(
      (e) => e.message,
    );
  return { db, couch, vault, deviceDeps, setMilestone, events };
}

describe('projectMilestone', () => {
  it('mirrors commonlib: ids from every section, PREFERRED excluded, fields typed', () => {
    const doc = milestone(
      { 'node-b': nodeInfo(), 'node-a': nodeInfo({ platform: 'ios', last_connected: 0 }) },
      {
        accepted_nodes: ['node-b', 'PREFERRED', 'node-locked-out'],
        node_chunk_info: { 'node-chunk-only': { min: 0, max: 0 } },
        tweak_values: { PREFERRED: {}, 'node-tweak-only': {} },
        locked: true,
      },
    );
    const projected = projectMilestone(doc);
    expect(projected.present).toBe(true);
    expect(projected.locked).toBe(true);
    expect(projected.nodes.map((n) => n.nodeId)).toEqual([
      'node-a',
      'node-b',
      'node-chunk-only',
      'node-locked-out',
      'node-tweak-only',
    ]);
    const a = projected.nodes.find((n) => n.nodeId === 'node-a')!;
    expect(a).toMatchObject({
      accepted: false,
      deviceName: 'Phone',
      vaultName: 'Notes',
      pluginVersion: '1.0.39',
      appVersion: '1.11.4',
      platform: 'ios',
      lastConnected: null, // 0 = never connected
    });
    const b = projected.nodes.find((n) => n.nodeId === 'node-b')!;
    expect(b).toMatchObject({
      accepted: true,
      platform: null,
      lastConnected: new Date(T0).toISOString(),
    });
    const chunkOnly = projected.nodes.find((n) => n.nodeId === 'node-chunk-only')!;
    expect(chunkOnly).toMatchObject({ deviceName: null, pluginVersion: null, lastConnected: null });
  });

  it('treats a missing or malformed document as absent', () => {
    expect(projectMilestone(undefined)).toEqual({
      present: false,
      locked: false,
      cleaned: false,
      nodes: [],
    });
    expect(projectMilestone({ node_info: 'garbage', accepted_nodes: 'nope' }).nodes).toEqual([]);
  });
});

describe('plugin version comparison', () => {
  it('compares numerically, not lexically', () => {
    expect(compareVersions('1.0.9', '1.0.37')).toBe(-1);
    expect(compareVersions('1.0.37', '1.0.37')).toBe(0);
    expect(compareVersions('1.1.0', '1.0.37')).toBe(1);
    expect(compareVersions('1.0', '1.0.0')).toBe(0);
    expect(compareVersions('1.0.37-0.diagnostic.1', '1.0.37')).toBe(-1);
    expect(compareVersions('v1.0.38', '1.0.37')).toBe(1);
    expect(compareVersions('dev', '1.0.37')).toBeNull();
  });

  it('flags only known-older plugins', () => {
    expect(isOutdatedPlugin('1.0.36')).toBe(true);
    expect(isOutdatedPlugin('0.25.10')).toBe(true);
    expect(isOutdatedPlugin(MIN_RECOMMENDED_PLUGIN_VERSION)).toBe(false);
    expect(isOutdatedPlugin('1.0.39')).toBe(false);
    expect(isOutdatedPlugin(null)).toBe(false);
    expect(isOutdatedPlugin('unknown')).toBe(false);
  });
});

describe('refreshVaultNodes', () => {
  it('reports an absent document without inventing clients', async () => {
    const { db, couch, vault } = await fixture();
    const result = await refreshVaultNodes({ db, couch }, vault.id);
    expect(result).toMatchObject({ milestone: 'absent', locked: false, nodes: [] });
    expect(result.minRecommendedPluginVersion).toBe(MIN_RECOMMENDED_PLUGIN_VERSION);
  });

  it('stores observations, keeps first_seen stable and never moves last_connected backwards', async () => {
    const { db, couch, vault, setMilestone } = await fixture();
    setMilestone(milestone({ 'node-1': nodeInfo() }));
    const first = await refreshVaultNodes({ db, couch }, vault.id, new Date(T0 + 1000));
    expect(first.milestone).toBe('present');
    expect(first.nodes).toHaveLength(1);
    expect(first.nodes[0]).toMatchObject({
      nodeId: 'node-1',
      label: 'Phone',
      pluginVersion: '1.0.39',
      outdated: false,
      lastConnected: new Date(T0).toISOString(),
      firstSeen: new Date(T0 + 1000).toISOString(),
      device: null,
    });

    // A later read with a newer connection, a platform, and a plugin update.
    setMilestone(
      milestone({
        'node-1': nodeInfo({
          last_connected: T0 + 60_000,
          platform: 'android',
          plugin_version: '1.0.40',
        }),
      }),
    );
    const second = await refreshVaultNodes({ db, couch }, vault.id, new Date(T0 + 120_000));
    expect(second.nodes[0]).toMatchObject({
      firstSeen: new Date(T0 + 1000).toISOString(),
      lastObserved: new Date(T0 + 120_000).toISOString(),
      lastConnected: new Date(T0 + 60_000).toISOString(),
      platform: 'android',
      pluginVersion: '1.0.40',
    });

    // A stale document (e.g. restored snapshot) must not rewind the timestamp.
    setMilestone(milestone({ 'node-1': nodeInfo({ last_connected: T0 - 5000 }) }));
    const third = await refreshVaultNodes({ db, couch }, vault.id, new Date(T0 + 180_000));
    expect(third.nodes[0]!.lastConnected).toBe(new Date(T0 + 60_000).toISOString());
    // platform sticks even when an older plugin stops reporting it
    expect(third.nodes[0]!.platform).toBe('android');
  });

  it('returns the stored observations when CouchDB fails, with the error', async () => {
    const { db, couch, vault, setMilestone } = await fixture();
    setMilestone(milestone({ 'node-1': nodeInfo() }));
    await refreshVaultNodes({ db, couch }, vault.id);
    couch.getLocalDoc = () =>
      Promise.reject(new CouchError('CouchDB GET failed: 503 unavailable', 503));
    const result = await refreshVaultNodes({ db, couch }, vault.id);
    expect(result.milestone).toBe('unavailable');
    expect(result.error).toContain('503');
    expect(result.nodes).toHaveLength(1);
  });

  it('marks clients stale after STALE_AFTER_DAYS without a connection', async () => {
    const { db, couch, vault, setMilestone } = await fixture();
    const now = new Date(T0 + (STALE_AFTER_DAYS + 1) * 24 * 60 * 60 * 1000);
    setMilestone(
      milestone({
        old: nodeInfo({ last_connected: T0 }),
        recent: nodeInfo({ last_connected: now.getTime() - 60_000 }),
        never: nodeInfo({ last_connected: 0 }),
      }),
    );
    const result = await refreshVaultNodes({ db, couch }, vault.id, now);
    const byId = (id: string) => result.nodes.find((n) => n.nodeId === id)!;
    expect(byId('old').stale).toBe(true);
    expect(byId('recent').stale).toBe(false);
    expect(byId('never').stale).toBe(true);
    expect(isStaleNode(new Date(now.getTime() - 1000).toISOString(), now)).toBe(false);
    expect(isStaleNode(null, now)).toBe(true);
  });

  it('flags outdated plugins', async () => {
    const { db, couch, vault, setMilestone } = await fixture();
    setMilestone(milestone({ old: nodeInfo({ plugin_version: '1.0.21' }), fresh: nodeInfo() }));
    const result = await refreshVaultNodes({ db, couch }, vault.id);
    expect(result.nodes.find((n) => n.nodeId === 'old')!.outdated).toBe(true);
    expect(result.nodes.find((n) => n.nodeId === 'fresh')!.outdated).toBe(false);
  });
});

describe('linking clients to devices', () => {
  it('auto-links a client first seen within an hour after exactly one device onboarded', async () => {
    const { db, couch, vault, deviceDeps, setMilestone, events } = await fixture();
    const { device } = await addDevice(deviceDeps, vault.id, { name: 'Phone' });
    markDeviceConnected(db, device.id);
    const connectedAt = Date.parse(listDevices(db, vault.id)[0]!.firstConnected!);

    setMilestone(milestone({ 'node-1': nodeInfo({ last_connected: connectedAt + 30_000 }) }));
    const result = await refreshVaultNodes({ db, couch }, vault.id, new Date(connectedAt + 60_000));
    expect(result.nodes[0]!.device).toEqual({ id: device.id, name: 'Phone' });
    expect(events()).toContainEqual(
      expect.stringMatching(/^Linked device Phone to LiveSync client Phone .*approximate/),
    );

    // Last seen follows the client's connection time, as an ISO string.
    const after = listDevices(db, vault.id)[0]!;
    expect(after.lastSeen).toBe(new Date(connectedAt + 30_000).toISOString());
  });

  it('leaves ambiguous cases alone: two devices in the window, or a client outside it', async () => {
    const { db, couch, vault, deviceDeps, setMilestone } = await fixture();
    const phone = (await addDevice(deviceDeps, vault.id, { name: 'Phone' })).device;
    const laptop = (await addDevice(deviceDeps, vault.id, { name: 'Laptop' })).device;
    markDeviceConnected(db, phone.id);
    markDeviceConnected(db, laptop.id);

    setMilestone(milestone({ 'node-1': nodeInfo() }));
    const ambiguous = await refreshVaultNodes({ db, couch }, vault.id);
    expect(ambiguous.nodes[0]!.device).toBeNull();

    // Only one device, but it onboarded two hours before the client appeared.
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    db.prepare('UPDATE devices SET first_connected = ? WHERE id = ?').run(twoHoursAgo, phone.id);
    db.prepare("UPDATE devices SET status = 'revoked' WHERE id = ?").run(laptop.id);
    const before = listDevices(db, vault.id).find((d) => d.id === phone.id)!.lastSeen;
    const late = await refreshVaultNodes({ db, couch }, vault.id);
    expect(late.nodes[0]!.device).toBeNull();
    // An unlinked device's last_seen is untouched by client activity.
    expect(listDevices(db, vault.id).find((d) => d.id === phone.id)!.lastSeen).toBe(before);
  });

  it('does not link two clients that appear together to the same device', async () => {
    const { db, couch, vault, deviceDeps, setMilestone } = await fixture();
    const { device } = await addDevice(deviceDeps, vault.id, { name: 'Phone' });
    markDeviceConnected(db, device.id);
    setMilestone(milestone({ 'node-1': nodeInfo(), 'node-2': nodeInfo({ device_name: 'Other' }) }));
    const result = await refreshVaultNodes({ db, couch }, vault.id);
    expect(result.nodes.every((n) => n.device === null)).toBe(true);
  });

  it('lets the admin link and unlink explicitly, with audit events', async () => {
    const { db, couch, vault, deviceDeps, setMilestone, events } = await fixture();
    const phone = (await addDevice(deviceDeps, vault.id, { name: 'Phone' })).device;
    const laptop = (await addDevice(deviceDeps, vault.id, { name: 'Laptop' })).device;
    setMilestone(milestone({ 'node-1': nodeInfo({ device_name: null }) }));
    await refreshVaultNodes({ db, couch }, vault.id);

    expect(() => setDeviceNode(db, phone.id, 'node-unknown')).toThrowError(
      /Refresh the vault page/,
    );

    const linked = setDeviceNode(db, phone.id, 'node-1');
    expect(linked.lastSeen).toBe(new Date(T0).toISOString());
    expect(events()).toContain('Linked device Phone to LiveSync client client node-1');

    expect(() => setDeviceNode(db, laptop.id, 'node-1')).toThrowError(
      /already linked to device Phone/,
    );
    // Idempotent re-link is a no-op.
    expect(setDeviceNode(db, phone.id, 'node-1').id).toBe(phone.id);

    const unlinked = setDeviceNode(db, phone.id, null);
    expect(unlinked.id).toBe(phone.id);
    expect(events()).toContain('Unlinked device Phone from LiveSync client client node-1');
    const nodes = await refreshVaultNodes({ db, couch }, vault.id);
    // Both devices are still pending (never confirmed), so nothing auto-links.
    expect(nodes.nodes[0]!.device).toBeNull();
    expect(setDeviceNode(db, laptop.id, 'node-1').id).toBe(laptop.id);
  });

  it('refuses to link a revoked device', async () => {
    const { db, couch, vault, deviceDeps, setMilestone } = await fixture();
    const { device } = await addDevice(deviceDeps, vault.id, { name: 'Phone' });
    setMilestone(milestone({ 'node-1': nodeInfo() }));
    await refreshVaultNodes({ db, couch }, vault.id);
    db.prepare("UPDATE devices SET status = 'revoked' WHERE id = ?").run(device.id);
    expect(() => setDeviceNode(db, device.id, 'node-1')).toThrowError(/revoked/);
  });

  it('never writes the milestone document', async () => {
    const { db, couch, vault, deviceDeps, setMilestone } = await fixture();
    const { device } = await addDevice(deviceDeps, vault.id, { name: 'Phone' });
    markDeviceConnected(db, device.id);
    const doc = milestone({ 'node-1': nodeInfo() });
    setMilestone(doc);
    let puts = 0;
    couch.putLocalDoc = () => {
      puts++;
      return Promise.resolve();
    };
    await refreshVaultNodes({ db, couch }, vault.id);
    setDeviceNode(db, device.id, null);
    expect(puts).toBe(0);
    expect(couch.databases.get(vault.couchDbName)!.localDocs.get(MILESTONE_DOC_ID)).toEqual(doc);
  });
});
