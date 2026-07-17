import { describe, expect, it } from 'vitest';
import { checkServerConfig, fixServerConfig, type ConfigClient } from './serverConfig.js';

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

const GOOD: Record<string, string> = {
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

describe('checkServerConfig', () => {
  it('passes a fully configured server', async () => {
    const result = await checkServerConfig(stubClient(GOOD));
    expect(result.ok).toBe(true);
    expect(result.node).toBe('couchdb@node1');
  });

  it('flags missing and wrong values', async () => {
    const result = await checkServerConfig(stubClient({}));
    expect(result.ok).toBe(false);
    expect(result.checks.filter((c) => c.section !== 'databases').every((c) => !c.ok)).toBe(true);
  });

  it('accepts extra CORS origins but requires all LiveSync ones', async () => {
    const extra = {
      ...GOOD,
      'cors/origins': 'https://mine.example.com,app://obsidian.md,capacitor://localhost',
    };
    const result = await checkServerConfig(stubClient(extra));
    const origins = result.checks.find((c) => c.section === 'cors' && c.key === 'origins')!;
    expect(origins.ok).toBe(false); // http://localhost missing
  });
});

describe('fixServerConfig', () => {
  it('applies only failing keys and rechecks green', async () => {
    const client = stubClient({ ...GOOD, 'chttpd/require_valid_user': 'false' });
    const result = await fixServerConfig(client);
    expect(result.applied).toEqual([{ section: 'chttpd', key: 'require_valid_user' }]);
    expect(result.persistence).toBe('unknown');
    expect(result.recheck.ok).toBe(true);
  });

  it('merges CORS origins instead of clobbering existing ones', async () => {
    const client = stubClient({ ...GOOD, 'cors/origins': 'https://mine.example.com' });
    const result = await fixServerConfig(client);
    expect(result.recheck.ok).toBe(true);
    const merged = client.store.get('cors/origins')!;
    expect(merged).toContain('https://mine.example.com');
    expect(merged).toContain('app://obsidian.md');
    expect(merged).toContain('capacitor://localhost');
    expect(merged).toContain('http://localhost');
  });

  it('is a no-op on a healthy server', async () => {
    const result = await fixServerConfig(stubClient(GOOD));
    expect(result.applied).toEqual([]);
    expect(result.recheck.ok).toBe(true);
  });

  it('creates missing system databases (fresh single-node install)', async () => {
    const client = stubClient(GOOD, []);
    const before = await checkServerConfig(client);
    expect(before.ok).toBe(false);
    const result = await fixServerConfig(client);
    expect(result.applied).toEqual([
      { section: 'databases', key: '_users' },
      { section: 'databases', key: '_replicator' },
    ]);
    expect(client.databases).toEqual(['_users', '_replicator']);
    expect(result.recheck.ok).toBe(true);
  });
});
