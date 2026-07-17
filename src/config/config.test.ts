import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from './index.js';

const required = {
  COUCHDB_ADMIN_URL: 'http://127.0.0.1:5984',
  COUCHDB_ADMIN_USER: 'admin',
  COUCHDB_ADMIN_PASSWORD: 'secret',
  COUCHDB_PUBLIC_URL: 'https://couchdb.example.com',
  PUBLIC_BASE_URL: 'https://livesync.example.com',
};

describe('loadConfig', () => {
  it('applies defaults over required env', () => {
    const config = loadConfig({ ...required });
    expect(config.port).toBe(8080);
    expect(config.host).toBe('0.0.0.0');
    expect(config.dataDir).toBe('/data');
    expect(config.trustProxy).toBe(false);
    expect(config.couchdb.adminUser).toBe('admin');
  });

  it('lets env override the config file', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'lsc-config-'));
    const file = path.join(dir, 'config.json');
    writeFileSync(file, JSON.stringify({ port: 9999, dataDir: '/from-file' }));
    const config = loadConfig({ ...required, CONFIG_FILE: file, PORT: '7777' });
    expect(config.port).toBe(7777);
    expect(config.dataDir).toBe('/from-file');
  });

  it('reports every missing required key at once, actionably', () => {
    expect(() => loadConfig({})).toThrowError(/couchdb\.adminUrl[\s\S]*publicBaseUrl/);
    expect(() => loadConfig({})).toThrowError(/docs\/DEPLOYMENT\.md/);
  });

  it('rejects a trailing slash on the CouchDB public URL', () => {
    expect(() =>
      loadConfig({ ...required, COUCHDB_PUBLIC_URL: 'https://couchdb.example.com/' }),
    ).toThrowError(/trailing slash/);
  });

  it('parses TRUST_PROXY strictly', () => {
    expect(loadConfig({ ...required, TRUST_PROXY: 'true' }).trustProxy).toBe(true);
    expect(loadConfig({ ...required, TRUST_PROXY: '1' }).trustProxy).toBe(true);
    expect(loadConfig({ ...required, TRUST_PROXY: 'false' }).trustProxy).toBe(false);
  });

  it('fails clearly on an unreadable config file', () => {
    expect(() => loadConfig({ ...required, CONFIG_FILE: '/nope/missing.json' })).toThrowError(
      /Cannot read config file \/nope\/missing\.json/,
    );
  });
});
