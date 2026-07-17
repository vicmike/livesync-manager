import { describe, expect, it } from 'vitest';
import { openDatabase } from '../db/index.js';
import { defaultMigrationsDir, runMigrations } from '../db/migrations.js';
import {
  createSession,
  destroySession,
  isSetupRequired,
  setAdminPassword,
  validateSession,
  verifyAdminPassword,
} from './auth.js';

function makeDb() {
  const db = openDatabase(':memory:');
  runMigrations(db, defaultMigrationsDir());
  return db;
}

describe('admin password', () => {
  it('starts in setup-required state and leaves it after setup', async () => {
    const db = makeDb();
    expect(isSetupRequired(db)).toBe(true);
    await setAdminPassword(db, 'a-long-enough-password');
    expect(isSetupRequired(db)).toBe(false);
  });

  it('verifies the right password and rejects the wrong one', async () => {
    const db = makeDb();
    await setAdminPassword(db, 'a-long-enough-password');
    expect(await verifyAdminPassword(db, 'a-long-enough-password')).toBe(true);
    expect(await verifyAdminPassword(db, 'not-the-password')).toBe(false);
  });

  it('rejects verification before setup', async () => {
    expect(await verifyAdminPassword(makeDb(), 'anything')).toBe(false);
  });

  it('enforces the minimum length actionably', async () => {
    await expect(setAdminPassword(makeDb(), 'short')).rejects.toThrowError(
      /at least 12 characters/,
    );
  });

  it('stores an argon2id hash, never the password', async () => {
    const db = makeDb();
    await setAdminPassword(db, 'a-long-enough-password');
    const stored = db
      .prepare("SELECT value FROM app_settings WHERE key = 'admin_password_hash'")
      .get() as { value: string };
    expect(stored.value).toMatch(/^\$argon2id\$/);
    expect(stored.value).not.toContain('a-long-enough-password');
  });
});

describe('sessions', () => {
  it('round-trips create/validate/destroy', () => {
    const db = makeDb();
    const { token } = createSession(db);
    const info = validateSession(db, token);
    expect(info).toBeDefined();
    destroySession(db, token);
    expect(validateSession(db, token)).toBeUndefined();
  });

  it('rejects unknown and expired tokens', () => {
    const db = makeDb();
    expect(validateSession(db, 'no-such-token')).toBeUndefined();
    const { token } = createSession(db);
    db.prepare('UPDATE sessions SET expires_at = ?').run(new Date(0).toISOString());
    expect(validateSession(db, token)).toBeUndefined();
  });

  it('stores hashed tokens only', () => {
    const db = makeDb();
    const { token } = createSession(db);
    const ids = (db.prepare('SELECT id FROM sessions').all() as { id: string }[]).map((r) => r.id);
    expect(ids).toHaveLength(1);
    expect(ids[0]).not.toBe(token);
    expect(ids[0]).toMatch(/^[0-9a-f]{64}$/);
  });

  it('purges expired sessions when a new one is created', () => {
    const db = makeDb();
    createSession(db);
    db.prepare('UPDATE sessions SET expires_at = ?').run(new Date(0).toISOString());
    createSession(db);
    expect(db.prepare('SELECT count(*) c FROM sessions').get()).toEqual({ c: 1 });
  });
});
