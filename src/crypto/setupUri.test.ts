import { describe, expect, it } from 'vitest';
import { decryptSetupUri, encryptSetupUri } from './setupUri.js';

const conf = {
  couchDB_URI: 'https://couchdb.example.com',
  couchDB_USER: 'device-phone',
  couchDB_PASSWORD: 'device-password',
  couchDB_DBNAME: 'vault-personal',
  encrypt: true,
  passphrase: 'the-e2ee-passphrase',
  settingVersion: 10,
};

describe('setup URI encryption', () => {
  it('round-trips through the same library the plugin uses', async () => {
    const uri = await encryptSetupUri(conf, 'misty-river-42');
    expect(uri.startsWith('obsidian://setuplivesync?settings=')).toBe(true);
    expect(uri).not.toContain('device-password');
    expect(uri).not.toContain('the-e2ee-passphrase');
    expect(await decryptSetupUri(uri, 'misty-river-42')).toEqual(conf);
  });

  it('rejects the wrong passphrase', async () => {
    const uri = await encryptSetupUri(conf, 'misty-river-42');
    await expect(decryptSetupUri(uri, 'wrong-pass-99')).rejects.toThrowError();
  });

  it('rejects non-setup URIs', async () => {
    await expect(decryptSetupUri('https://example.com', 'x')).rejects.toThrowError(
      /Not a LiveSync setup URI/,
    );
  });
});
