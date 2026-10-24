import { describe, expect, it, vi } from 'vitest';
import { checkRemoteVersion } from '@vrtmrz/livesync-commonlib/compat/pouchdb/negotiation';
import { LIVESYNC_VERSION_DOC } from './vaults.js';

// LIVESYNC_INTEGRATION.md § 3: the marker we stamp into a fresh vault
// database is also the plugin's remote feature-negotiation record. These
// tests run commonlib's own check (the code every device runs on connect)
// against our marker, so a change in what upstream accepts fails here
// rather than on a phone.

type VersionDoc = Record<string, unknown> & { _id: string; _rev?: string };

function fakeDb(initial: VersionDoc | undefined) {
  let doc = initial;
  const db = {
    get: vi.fn(async (id: string) => {
      if (doc && id === doc._id) return doc;
      throw Object.assign(new Error('missing'), { status: 404, name: 'not_found' });
    }),
    put: vi.fn(async (next: VersionDoc) => {
      doc = { ...next, _rev: `${Number(doc?._rev?.split('-')[0] ?? 0) + 1}-x` };
      return { ok: true, id: next._id, rev: doc._rev };
    }),
    info: vi.fn(async () => ({ doc_count: doc ? 1 : 0 })),
  };
  return {
    db: db as unknown as Parameters<typeof checkRemoteVersion>[0],
    ops: db,
    current: () => doc,
  };
}

const ourMarker: VersionDoc = {
  _id: LIVESYNC_VERSION_DOC.id,
  _rev: '1-x',
  ...LIVESYNC_VERSION_DOC.doc,
};

describe('LiveSync remote version marker', () => {
  it('is accepted as-is by a client that uses no optional features', async () => {
    const { db, ops } = fakeDb(ourMarker);
    const migrate = vi.fn(async () => true);
    expect(await checkRemoteVersion(db, migrate)).toBe(true);
    expect(migrate).not.toHaveBeenCalled();
    expect(ops.put).not.toHaveBeenCalled();
  });

  it('is upgraded to generation 13 by a client enabling a 1.0.33+ feature', async () => {
    // A legitimate client-side change to "our" document: adopt/restore and
    // health checks must preserve it, never reset it to 12.
    const { db, current } = fakeDb(ourMarker);
    const ok = await checkRemoteVersion(db, async () => true, undefined, [
      'independent-id-derivation-v1',
    ]);
    expect(ok).toBe(true);
    expect(current()).toMatchObject({
      version: 13,
      type: 'versioninfo',
      used_features: ['independent-id-derivation-v1'],
    });
  });

  it('is what a client stamps into an empty database itself', async () => {
    // provision.ts relies on this path; we stamp the same thing up front so
    // the database is recognisably LiveSync's before any device connects.
    const { db, current } = fakeDb(undefined);
    expect(await checkRemoteVersion(db, async () => true)).toBe(true);
    expect(current()).toMatchObject(LIVESYNC_VERSION_DOC.doc);
  });
});
