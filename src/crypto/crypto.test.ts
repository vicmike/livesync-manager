import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { decryptSecret, encryptSecret, safeEqual } from './index.js';

const key = randomBytes(32);
const aad = { table: 'vaults', column: 'e2ee_passphrase_enc', rowId: 'row-1' };

describe('secret envelope', () => {
  it('round-trips', () => {
    const envelope = encryptSecret(key, 'correct horse battery staple', aad);
    expect(decryptSecret(key, envelope, aad)).toBe('correct horse battery staple');
  });

  it('produces a fresh nonce per encryption', () => {
    const a = encryptSecret(key, 'same', aad);
    const b = encryptSecret(key, 'same', aad);
    expect(a.equals(b)).toBe(false);
  });

  it('rejects a ciphertext moved to another row (AAD mismatch)', () => {
    const envelope = encryptSecret(key, 'secret', aad);
    expect(() => decryptSecret(key, envelope, { ...aad, rowId: 'row-2' })).toThrowError(
      /wrong master key, or the value was tampered/,
    );
  });

  it('rejects a tampered ciphertext', () => {
    const envelope = encryptSecret(key, 'secret', aad);
    envelope[envelope.length - 1]! ^= 0xff;
    expect(() => decryptSecret(key, envelope, aad)).toThrowError(/tampered/);
  });

  it('rejects the wrong key', () => {
    const envelope = encryptSecret(key, 'secret', aad);
    expect(() => decryptSecret(randomBytes(32), envelope, aad)).toThrowError(/wrong master key/);
  });

  it('rejects unknown envelope versions and truncated values', () => {
    const envelope = encryptSecret(key, 'secret', aad);
    envelope[0] = 9;
    expect(() => decryptSecret(key, envelope, aad)).toThrowError(/version 9/);
    expect(() => decryptSecret(key, envelope.subarray(0, 10), aad)).toThrowError(/truncated/);
  });
});

describe('safeEqual', () => {
  it('compares equal and unequal strings', () => {
    expect(safeEqual('token-a', 'token-a')).toBe(true);
    expect(safeEqual('token-a', 'token-b')).toBe(false);
    expect(safeEqual('short', 'longer-string')).toBe(false);
  });
});
