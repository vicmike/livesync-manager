import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Config } from './index.js';

export const MASTER_KEY_BYTES = 32;

export interface MasterKeyResult {
  key: Buffer;
  source: 'env' | 'file' | 'generated';
  /** Set when the key file permissions are wider than 0600. */
  warning?: string;
}

/**
 * Resolves the master key per SECURITY.md § Master key: MASTER_KEY (base64)
 * wins; otherwise the key file is read, or generated on first boot with
 * mode 0600. Losing this key loses every stored secret; callers surface
 * the generated-key message so the admin knows to back up the data dir.
 */
export function loadMasterKey(config: Config): MasterKeyResult {
  if (config.masterKey !== undefined) {
    const key = Buffer.from(config.masterKey, 'base64');
    if (key.length !== MASTER_KEY_BYTES) {
      throw new Error(
        `MASTER_KEY must be base64 of exactly ${MASTER_KEY_BYTES} bytes (got ${key.length}). ` +
          `Generate one with: openssl rand -base64 32`,
      );
    }
    return { key, source: 'env' };
  }

  const file = config.masterKeyFile ?? path.join(config.dataDir, 'master.key');
  let existing: Buffer | undefined;
  try {
    existing = readFileSync(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new Error(`Cannot read master key file ${file}: ${(err as Error).message}`, {
        cause: err,
      });
    }
  }

  if (existing !== undefined) {
    if (existing.length !== MASTER_KEY_BYTES) {
      throw new Error(
        `Master key file ${file} is ${existing.length} bytes, expected ${MASTER_KEY_BYTES}. ` +
          `It may be corrupted or not a key file; refusing to start. ` +
          `Restore it from backup; do not delete it, or every stored secret is lost.`,
      );
    }
    const mode = statSync(file).mode & 0o777;
    const warning =
      (mode & 0o077) !== 0
        ? `Master key file ${file} has mode ${mode.toString(8)}; tighten it with: chmod 600 ${file}`
        : undefined;
    return warning ? { key: existing, source: 'file', warning } : { key: existing, source: 'file' };
  }

  const key = randomBytes(MASTER_KEY_BYTES);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, key, { mode: 0o600, flag: 'wx' });
  return { key, source: 'generated' };
}
