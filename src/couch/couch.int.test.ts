// Integration tests against a real CouchDB, using throwaway lsc-int-*
// database and user names that are cleaned up afterwards. Safe to point at
// a shared server, EXCEPT the server-configuration suite, which mutates
// global config and only runs when COUCHDB_TEST_ALLOW_CONFIG_MUTATION=1
// (set it only against a disposable instance).
//
//   docker compose -f dev/couchdb.yml up      (or dev/couchdb-k8s.sh)
//   COUCHDB_TEST_ALLOW_CONFIG_MUTATION=1 npm run test:integration
//
// Target selection: COUCHDB_TEST_URL / _USER / _PASSWORD.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CouchClient } from './client.js';
import { checkServerConfig, fixServerConfig } from '../services/serverConfig.js';

const url = process.env.COUCHDB_TEST_URL ?? 'http://127.0.0.1:5984';
const user = process.env.COUCHDB_TEST_USER ?? 'admin';
const password = process.env.COUCHDB_TEST_PASSWORD ?? 'admin';
const allowConfigMutation = process.env.COUCHDB_TEST_ALLOW_CONFIG_MUTATION === '1';

const client = new CouchClient({ url, user, password });
const RUN = `lsc-int-${Date.now()}`;
const TEST_USER = `${RUN}-device`;

beforeAll(async () => {
  // The CouchDB may still be starting.
  const deadline = Date.now() + 90_000;
  for (;;) {
    try {
      await client.up();
      break;
    } catch (err) {
      if (Date.now() > deadline) {
        throw new Error(
          `No CouchDB at ${url} after 90s. Start one with: docker compose -f dev/couchdb.yml up`,
          { cause: err },
        );
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  // _users is not auto-created on fresh single-node installs.
  if (!(await client.listDatabases()).includes('_users')) {
    await client.createDatabase('_users');
  }
}, 120_000);

afterAll(async () => {
  // Best-effort cleanup of anything a failed test left behind.
  for (const db of await client.listDatabases()) {
    if (db.startsWith(RUN)) {
      await client.deleteDatabase(db).catch(() => {});
    }
  }
  await client.deleteUser(TEST_USER).catch(() => {});
});

describe('database lifecycle', () => {
  it('creates, inspects, and deletes a database', async () => {
    const db = `${RUN}-lifecycle`;
    await client.createDatabase(db);
    expect(await client.listDatabases()).toContain(db);
    const info = await client.databaseInfo(db);
    expect(info.db_name).toBe(db);
    expect(info.doc_count).toBe(0);
    await client.deleteDatabase(db);
    expect(await client.listDatabases()).not.toContain(db);
  });
});

describe('users and security', () => {
  it('creates a user, rotates its password, and deletes it', async () => {
    await client.putUser(TEST_USER, 'first-password');
    const created = await client.getUser(TEST_USER);
    expect(created?.name).toBe(TEST_USER);

    await client.putUser(TEST_USER, 'second-password');
    const rotated = await client.getUser(TEST_USER);
    expect(rotated?._rev).not.toBe(created?._rev);

    await client.deleteUser(TEST_USER);
    expect(await client.getUser(TEST_USER)).toBeUndefined();
  });

  it('round-trips a _security object', async () => {
    const db = `${RUN}-sec`;
    await client.createDatabase(db);
    const security = { admins: { names: [], roles: [] }, members: { names: [TEST_USER] } };
    await client.setSecurity(db, security);
    const stored = await client.getSecurity(db);
    expect(stored.members?.names).toEqual([TEST_USER]);
    await client.deleteDatabase(db);
  });
});

describe('replication', () => {
  it('replicates one database into another', async () => {
    const source = `${RUN}-src`;
    const target = `${RUN}-dst`;
    const authority = new URL(url);
    authority.username = user;
    authority.password = password;
    await client.createDatabase(source);
    await client.putDocument(source, 'doc-1', { hello: 'world' });
    await client.putDocument(source, 'doc-2', { hello: 'again' });

    await client.replicate({
      source: new URL(source, authority).href,
      target: new URL(target, authority).href,
      create_target: true,
    });

    const info = await client.databaseInfo(target);
    expect(info.doc_count).toBe(2);
    const doc = await client.getDocument<{ hello: string }>(target, 'doc-1');
    expect(doc.hello).toBe('world');

    await client.deleteDatabase(source);
    await client.deleteDatabase(target);
  });
});

// Mutates global server config; disposable instances only (see header).
describe.runIf(allowConfigMutation)('server configuration check and fix', () => {
  it('converges the server to green and is idempotent', async () => {
    const before = await checkServerConfig(client);
    const fixed = await fixServerConfig(client);
    expect(fixed.recheck.ok).toBe(true);
    if (!before.ok) {
      expect(fixed.applied.length).toBeGreaterThan(0);
    }

    // Idempotent: a second fix has nothing to do.
    const again = await fixServerConfig(client);
    expect(again.applied).toEqual([]);

    // Admin requests still work with require_valid_user=true.
    expect((await client.serverInfo()).version).toBeTruthy();
  });
});
