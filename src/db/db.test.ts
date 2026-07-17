import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { getSetting, setSetting } from './appSettings.js';
import { openDatabase } from './index.js';
import { defaultMigrationsDir, runMigrations } from './migrations.js';

describe('migrations', () => {
  it('applies the initial schema once and is idempotent', () => {
    const db = openDatabase(':memory:');
    const first = runMigrations(db, defaultMigrationsDir());
    expect(first).toContain('0001_init.sql');
    expect(runMigrations(db, defaultMigrationsDir())).toEqual([]);

    const tables = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
        name: string;
      }[]
    ).map((t) => t.name);
    for (const table of [
      'app_settings',
      'vaults',
      'devices',
      'invites',
      'backups',
      'health_snapshots',
      'events',
    ]) {
      expect(tables).toContain(table);
    }
  });

  it('applies migrations in lexical order', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'lsc-mig-'));
    writeFileSync(path.join(dir, '0002_two.sql'), 'CREATE TABLE two (id TEXT);');
    writeFileSync(path.join(dir, '0001_one.sql'), 'CREATE TABLE one (id TEXT);');
    const db = openDatabase(':memory:');
    expect(runMigrations(db, dir)).toEqual(['0001_one.sql', '0002_two.sql']);
  });

  it('refuses to run when an applied migration was edited', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'lsc-mig-'));
    const file = path.join(dir, '0001_one.sql');
    writeFileSync(file, 'CREATE TABLE one (id TEXT);');
    const db = openDatabase(':memory:');
    runMigrations(db, dir);
    writeFileSync(file, 'CREATE TABLE one (id TEXT, extra TEXT);');
    expect(() => runMigrations(db, dir)).toThrowError(/changed after it was applied/);
  });

  it('rolls back a failing migration atomically', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'lsc-mig-'));
    writeFileSync(path.join(dir, '0001_bad.sql'), 'CREATE TABLE ok (id TEXT); THIS IS NOT SQL;');
    const db = openDatabase(':memory:');
    expect(() => runMigrations(db, dir)).toThrowError();
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE name = 'ok'").all();
    expect(tables).toEqual([]);
    expect(db.prepare('SELECT count(*) c FROM schema_migrations').get()).toEqual({ c: 0 });
  });
});

describe('app settings', () => {
  it('gets, sets, and overwrites values', () => {
    const db = openDatabase(':memory:');
    runMigrations(db, defaultMigrationsDir());
    expect(getSetting(db, 'admin_password_hash')).toBeUndefined();
    setSetting(db, 'admin_password_hash', 'v1');
    expect(getSetting(db, 'admin_password_hash')).toBe('v1');
    setSetting(db, 'admin_password_hash', 'v2');
    expect(getSetting(db, 'admin_password_hash')).toBe('v2');
  });
});
