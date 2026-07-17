import { createHash, randomBytes } from 'node:crypto';
import argon2 from 'argon2';
import type { AppDatabase } from '../db/index.js';
import { getSetting, setSetting } from '../db/appSettings.js';

// Pinned argon2id parameters (SECURITY.md § Credentials). Changing them is
// a security decision: update SECURITY.md first. Existing hashes are
// upgraded transparently on the next successful login.
const ARGON2_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 65536, // 64 MiB
  timeCost: 3,
  parallelism: 4,
} as const;

const PASSWORD_HASH_KEY = 'admin_password_hash';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const MIN_PASSWORD_LENGTH = 12;

export function isSetupRequired(db: AppDatabase): boolean {
  return getSetting(db, PASSWORD_HASH_KEY) === undefined;
}

export async function setAdminPassword(db: AppDatabase, password: string): Promise<void> {
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new PasswordPolicyError(
      `Password must be at least ${MIN_PASSWORD_LENGTH} characters. ` +
        `Use a password manager and a generated passphrase.`,
    );
  }
  setSetting(db, PASSWORD_HASH_KEY, await argon2.hash(password, ARGON2_OPTIONS));
}

export async function verifyAdminPassword(db: AppDatabase, password: string): Promise<boolean> {
  const hash = getSetting(db, PASSWORD_HASH_KEY);
  if (hash === undefined) {
    return false;
  }
  const ok = await argon2.verify(hash, password);
  if (ok && argon2.needsRehash(hash, ARGON2_OPTIONS)) {
    setSetting(db, PASSWORD_HASH_KEY, await argon2.hash(password, ARGON2_OPTIONS));
  }
  return ok;
}

export class PasswordPolicyError extends Error {}

/**
 * Other sessions die with the old password; the caller's stays. Callers pass
 * the raw cookie token of the session to keep.
 */
export function destroyOtherSessions(db: AppDatabase, keepToken: string): number {
  return db.prepare('DELETE FROM sessions WHERE id != ?').run(hashToken(keepToken)).changes;
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function createSession(db: AppDatabase): { token: string; expiresAt: Date } {
  // Opportunistic cleanup keeps the table from accumulating dead rows.
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(new Date().toISOString());

  const token = randomBytes(32).toString('base64url');
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
  db.prepare(
    'INSERT INTO sessions (id, created_at, expires_at, last_used_at) VALUES (?, ?, ?, ?)',
  ).run(hashToken(token), now.toISOString(), expiresAt.toISOString(), now.toISOString());
  return { token, expiresAt };
}

export interface SessionInfo {
  createdAt: string;
  expiresAt: string;
}

export function validateSession(db: AppDatabase, token: string): SessionInfo | undefined {
  const row = db
    .prepare('SELECT created_at, expires_at FROM sessions WHERE id = ?')
    .get(hashToken(token)) as { created_at: string; expires_at: string } | undefined;
  if (!row || row.expires_at < new Date().toISOString()) {
    return undefined;
  }
  db.prepare('UPDATE sessions SET last_used_at = ? WHERE id = ?').run(
    new Date().toISOString(),
    hashToken(token),
  );
  return { createdAt: row.created_at, expiresAt: row.expires_at };
}

export function destroySession(db: AppDatabase, token: string): void {
  db.prepare('DELETE FROM sessions WHERE id = ?').run(hashToken(token));
}
