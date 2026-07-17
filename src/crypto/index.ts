import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';

// Envelope layout: version(1) || nonce(12) || tag(16) || ciphertext.
// AAD binds a ciphertext to its table/column/row so values cannot be
// swapped between rows without detection (SECURITY.md § Master key).
const VERSION = 1;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

export interface SecretAad {
  table: string;
  column: string;
  rowId: string;
}

function aadBuffer({ table, column, rowId }: SecretAad): Buffer {
  return Buffer.from(`${table}.${column}.${rowId}`, 'utf8');
}

export function encryptSecret(masterKey: Buffer, plaintext: string, aad: SecretAad): Buffer {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv('aes-256-gcm', masterKey, nonce);
  cipher.setAAD(aadBuffer(aad));
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([Buffer.from([VERSION]), nonce, cipher.getAuthTag(), ciphertext]);
}

export function decryptSecret(masterKey: Buffer, envelope: Buffer, aad: SecretAad): string {
  if (envelope.length < 1 + NONCE_BYTES + TAG_BYTES) {
    throw new Error('Encrypted value is truncated');
  }
  const version = envelope[0];
  if (version !== VERSION) {
    throw new Error(`Unknown secret envelope version ${version}`);
  }
  const nonce = envelope.subarray(1, 1 + NONCE_BYTES);
  const tag = envelope.subarray(1 + NONCE_BYTES, 1 + NONCE_BYTES + TAG_BYTES);
  const ciphertext = envelope.subarray(1 + NONCE_BYTES + TAG_BYTES);
  const decipher = createDecipheriv('aes-256-gcm', masterKey, nonce);
  decipher.setAAD(aadBuffer(aad));
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch {
    throw new Error(
      'Failed to decrypt stored secret: wrong master key, or the value was tampered with',
    );
  }
}

/** Constant-time string comparison for token checks (SECURITY.md § Invite links). */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
