import { describe, expect, it } from 'vitest';
import {
  decodeSettingsFromSetupURI,
  encodeSettingsToSetupURI,
} from '@vrtmrz/livesync-commonlib/compat/API/processSetting';
import { DEFAULT_SETTINGS } from '@vrtmrz/livesync-commonlib/settings';
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

// LIVESYNC_INTEGRATION.md § 1 requires round-tripping against plugin code,
// not just against ourselves. @vrtmrz/livesync-commonlib is the library the
// plugin itself runs, so these tests prove real-device compatibility.
describe('compatibility with the plugin decoder (livesync-commonlib)', () => {
  it('URIs we generate decode with the exact code the plugin runs', async () => {
    const uri = await encryptSetupUri(conf, 'misty-river-42');
    const decoded = await decodeSettingsFromSetupURI(uri, 'misty-river-42');
    expect(decoded).not.toBe(false);
    expect(decoded).toMatchObject(conf);
  });

  it('the plugin decoder rejects our URI under the wrong passphrase', async () => {
    const uri = await encryptSetupUri(conf, 'misty-river-42');
    await expect(decodeSettingsFromSetupURI(uri, 'wrong-pass-99')).rejects.toThrowError();
  });

  it('current plugin releases emit HKDF URIs, which we do not decode', async () => {
    // We only ever decode URIs we generated ourselves, so this asymmetry is
    // fine — but if it ever starts passing, the formats converged and this
    // fixture should be revisited.
    const settings = { ...DEFAULT_SETTINGS, ...conf };
    const theirUri = await encodeSettingsToSetupURI(settings, 'misty-river-42', [], true);
    expect(decodeURIComponent(theirUri.slice(theirUri.indexOf('=') + 1)).startsWith('%$')).toBe(
      true,
    );
    await expect(decryptSetupUri(theirUri.trim(), 'misty-river-42')).rejects.toThrowError();
    // Their own decoder accepts it, proving the fixture is a valid URI.
    expect(await decodeSettingsFromSetupURI(theirUri.trim(), 'misty-river-42')).toMatchObject({
      couchDB_URI: conf.couchDB_URI,
    });
  });
});
