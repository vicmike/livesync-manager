import { randomBytes } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { makeTestConfig } from '../testing.js';
import { loadMasterKey, MASTER_KEY_BYTES } from './masterKey.js';

function tmpDataDir(): string {
  return mkdtempSync(path.join(os.tmpdir(), 'lsc-key-'));
}

describe('loadMasterKey', () => {
  it('generates a key file with mode 0600 on first boot', () => {
    const dataDir = tmpDataDir();
    const result = loadMasterKey(makeTestConfig({ DATA_DIR: dataDir }));
    expect(result.source).toBe('generated');
    expect(result.key.length).toBe(MASTER_KEY_BYTES);
    const file = path.join(dataDir, 'master.key');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(file)).toEqual(result.key);
  });

  it('loads an existing key file', () => {
    const dataDir = tmpDataDir();
    const first = loadMasterKey(makeTestConfig({ DATA_DIR: dataDir }));
    const second = loadMasterKey(makeTestConfig({ DATA_DIR: dataDir }));
    expect(second.source).toBe('file');
    expect(second.key).toEqual(first.key);
    expect(second.warning).toBeUndefined();
  });

  it('prefers MASTER_KEY from the environment', () => {
    const key = randomBytes(MASTER_KEY_BYTES);
    const result = loadMasterKey(makeTestConfig({ MASTER_KEY: key.toString('base64') }));
    expect(result.source).toBe('env');
    expect(result.key).toEqual(key);
  });

  it('rejects a MASTER_KEY of the wrong length', () => {
    const short = randomBytes(16).toString('base64');
    expect(() => loadMasterKey(makeTestConfig({ MASTER_KEY: short }))).toThrowError(
      /exactly 32 bytes/,
    );
  });

  it('refuses to start on a corrupt key file', () => {
    const dataDir = tmpDataDir();
    writeFileSync(path.join(dataDir, 'master.key'), randomBytes(31));
    expect(() => loadMasterKey(makeTestConfig({ DATA_DIR: dataDir }))).toThrowError(
      /refusing to start/,
    );
  });

  it('warns when the key file permissions are too open', () => {
    const dataDir = tmpDataDir();
    loadMasterKey(makeTestConfig({ DATA_DIR: dataDir }));
    chmodSync(path.join(dataDir, 'master.key'), 0o644);
    const result = loadMasterKey(makeTestConfig({ DATA_DIR: dataDir }));
    expect(result.warning).toMatch(/chmod 600/);
  });

  it('honors MASTER_KEY_FILE over the data dir default', () => {
    const dataDir = tmpDataDir();
    const file = path.join(tmpDataDir(), 'elsewhere.key');
    const result = loadMasterKey(makeTestConfig({ DATA_DIR: dataDir, MASTER_KEY_FILE: file }));
    expect(result.source).toBe('generated');
    expect(readFileSync(file)).toEqual(result.key);
  });
});
