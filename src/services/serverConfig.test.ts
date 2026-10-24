import { describe, expect, it } from 'vitest';
import {
  checkServerConfig,
  fixServerConfig,
  isModernCouchDB,
  type ConfigClient,
} from './serverConfig.js';

function stubClient(
  initial: Record<string, string>,
  databases: string[] = ['_users', '_replicator'],
): ConfigClient & { store: Map<string, string>; databases: string[] } {
  const store = new Map(Object.entries(initial));
  return {
    store,
    databases,
    membershipNode: () => Promise.resolve('couchdb@node1'),
    getConfig: (_node, section, key) => Promise.resolve(store.get(`${section}/${key}`)),
    setConfig: (_node, section, key, value) => {
      store.set(`${section}/${key}`, value);
      return Promise.resolve();
    },
    listDatabases() {
      return Promise.resolve([...this.databases]);
    },
    createDatabase(name: string) {
      this.databases.push(name);
      return Promise.resolve();
    },
  };
}

// What upstream's reference local.ini sets: modern keys only.
const GOOD: Record<string, string> = {
  'chttpd/require_valid_user': 'true',
  'httpd/WWW-Authenticate': 'Basic realm="couchdb"',
  'chttpd/enable_cors': 'true',
  'chttpd/max_http_request_size': '4294967296',
  'couchdb/max_document_size': '50000000',
  'cors/credentials': 'true',
  'cors/origins': 'app://obsidian.md,capacitor://localhost,http://localhost',
};

const GOOD_LEGACY: Record<string, string> = {
  ...GOOD,
  'chttpd_auth/require_valid_user': 'true',
  'httpd/enable_cors': 'true',
};

const failing = (checks: { ok: boolean; section: string; key: string }[]) =>
  checks.filter((c) => !c.ok).map((c) => `${c.section}/${c.key}`);

describe('isModernCouchDB', () => {
  it('splits at 3.2 and treats unknown as modern', () => {
    expect(isModernCouchDB('3.1.2')).toBe(false);
    expect(isModernCouchDB('3.2.0')).toBe(true);
    expect(isModernCouchDB('3.10.1')).toBe(true);
    expect(isModernCouchDB('4.0.0')).toBe(true);
    expect(isModernCouchDB(undefined)).toBe(true);
    expect(isModernCouchDB('garbage')).toBe(true);
  });
});

describe('checkServerConfig', () => {
  it('passes a server configured with only the modern keys (CouchDB 3.3)', async () => {
    const result = await checkServerConfig(stubClient(GOOD), '3.3.3');
    expect(result.ok).toBe(true);
    expect(result.node).toBe('couchdb@node1');
    expect(result.couchdbVersion).toBe('3.3.3');
    // Legacy keys are not demanded and, being unset, not even listed.
    expect(result.checks.map((c) => `${c.section}/${c.key}`)).not.toContain(
      'chttpd_auth/require_valid_user',
    );
    expect(result.checks.map((c) => `${c.section}/${c.key}`)).not.toContain('httpd/enable_cors');
  });

  it('reports legacy keys on a modern server as informational, never failing', async () => {
    const result = await checkServerConfig(stubClient(GOOD_LEGACY), '3.3.3');
    expect(result.ok).toBe(true);
    const legacy = result.checks.find(
      (c) => c.section === 'chttpd_auth' && c.key === 'require_valid_user',
    )!;
    expect(legacy.required).toBe(false);
    expect(legacy.ok).toBe(true);
    expect(legacy.note).toMatch(/ignores this legacy key/);
  });

  it('requires the legacy keys below 3.2 and not the modern ones', async () => {
    const legacyOnly = { ...GOOD_LEGACY };
    delete legacyOnly['chttpd/require_valid_user'];
    delete legacyOnly['chttpd/enable_cors'];
    expect((await checkServerConfig(stubClient(legacyOnly), '3.1.2')).ok).toBe(true);

    const modernOnlyOnOld = await checkServerConfig(stubClient(GOOD), '3.1.2');
    expect(failing(modernOnlyOnOld.checks)).toEqual([
      'chttpd_auth/require_valid_user',
      'httpd/enable_cors',
    ]);
  });

  it('flags missing and wrong values', async () => {
    const result = await checkServerConfig(stubClient({}), '3.3.3');
    expect(result.ok).toBe(false);
    expect(result.checks.filter((c) => c.section !== 'databases').every((c) => !c.ok)).toBe(true);
  });

  it('treats the size limits as minimums', async () => {
    const larger = {
      ...GOOD,
      'chttpd/max_http_request_size': '8589934592',
      'couchdb/max_document_size': '100000000',
    };
    expect((await checkServerConfig(stubClient(larger), '3.3.3')).ok).toBe(true);

    const smaller = { ...GOOD, 'couchdb/max_document_size': '49999999' };
    const result = await checkServerConfig(stubClient(smaller), '3.3.3');
    expect(failing(result.checks)).toEqual(['couchdb/max_document_size']);
    expect(result.checks.find((c) => c.key === 'max_document_size')!.expected).toBe(
      'at least 50000000',
    );

    const garbage = { ...GOOD, 'chttpd/max_http_request_size': 'lots' };
    expect(failing((await checkServerConfig(stubClient(garbage), '3.3.3')).checks)).toEqual([
      'chttpd/max_http_request_size',
    ]);
  });

  it('accepts extra CORS origins but requires all LiveSync ones', async () => {
    const extra = {
      ...GOOD,
      'cors/origins': 'https://mine.example.com,app://obsidian.md,capacitor://localhost',
    };
    const result = await checkServerConfig(stubClient(extra), '3.3.3');
    const origins = result.checks.find((c) => c.section === 'cors' && c.key === 'origins')!;
    expect(origins.ok).toBe(false); // http://localhost missing
  });

  it('accepts a wildcard origin with a recommendation note', async () => {
    const result = await checkServerConfig(stubClient({ ...GOOD, 'cors/origins': '*' }), '3.3.3');
    expect(result.ok).toBe(true);
    const origins = result.checks.find((c) => c.section === 'cors' && c.key === 'origins')!;
    expect(origins.note).toMatch(/wildcard/i);
  });
});

describe('fixServerConfig', () => {
  it('applies only failing keys and rechecks green', async () => {
    const client = stubClient({ ...GOOD, 'chttpd/require_valid_user': 'false' });
    const result = await fixServerConfig(client, '3.3.3');
    expect(result.applied).toEqual([{ section: 'chttpd', key: 'require_valid_user' }]);
    expect(result.persistence).toBe('unknown');
    expect(result.recheck.ok).toBe(true);
  });

  it('writes the exact reference value when a size is below the minimum', async () => {
    const client = stubClient({ ...GOOD, 'couchdb/max_document_size': '1000' });
    const result = await fixServerConfig(client, '3.3.3');
    expect(result.applied).toEqual([{ section: 'couchdb', key: 'max_document_size' }]);
    expect(client.store.get('couchdb/max_document_size')).toBe('50000000');
    expect(result.recheck.ok).toBe(true);
  });

  it('never touches informational legacy keys or a wildcard origin', async () => {
    const client = stubClient({ ...GOOD_LEGACY, 'cors/origins': '*' });
    const result = await fixServerConfig(client, '3.3.3');
    expect(result.applied).toEqual([]);
    expect(client.store.get('cors/origins')).toBe('*');
  });

  it('fixes the legacy keys on a pre-3.2 server', async () => {
    const client = stubClient(GOOD);
    const result = await fixServerConfig(client, '3.1.2');
    expect(result.applied).toEqual([
      { section: 'chttpd_auth', key: 'require_valid_user' },
      { section: 'httpd', key: 'enable_cors' },
    ]);
    expect(result.recheck.ok).toBe(true);
  });

  it('merges CORS origins instead of clobbering existing ones', async () => {
    const client = stubClient({ ...GOOD, 'cors/origins': 'https://mine.example.com' });
    const result = await fixServerConfig(client, '3.3.3');
    expect(result.recheck.ok).toBe(true);
    const merged = client.store.get('cors/origins')!;
    expect(merged).toContain('https://mine.example.com');
    expect(merged).toContain('app://obsidian.md');
    expect(merged).toContain('capacitor://localhost');
    expect(merged).toContain('http://localhost');
  });

  it('is a no-op on a healthy server', async () => {
    const result = await fixServerConfig(stubClient(GOOD), '3.3.3');
    expect(result.applied).toEqual([]);
    expect(result.recheck.ok).toBe(true);
  });

  it('creates missing system databases (fresh single-node install)', async () => {
    const client = stubClient(GOOD, []);
    const before = await checkServerConfig(client, '3.3.3');
    expect(before.ok).toBe(false);
    const result = await fixServerConfig(client, '3.3.3');
    expect(result.applied).toEqual([
      { section: 'databases', key: '_users' },
      { section: 'databases', key: '_replicator' },
    ]);
    expect(client.databases).toEqual(['_users', '_replicator']);
    expect(result.recheck.ok).toBe(true);
  });
});
