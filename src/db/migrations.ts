import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { AppDatabase } from './index.js';

interface AppliedMigration {
  name: string;
  checksum: string;
}

/**
 * Applies migrations/*.sql in lexical order, each inside a transaction.
 * Applied migrations are recorded with a checksum; editing an applied file
 * is an error; write a new migration instead.
 */
export function runMigrations(db: AppDatabase, dir: string): string[] {
  db.exec(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       name       TEXT PRIMARY KEY,
       checksum   TEXT NOT NULL,
       applied_at TEXT NOT NULL
     )`,
  );

  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  const applied = new Map<string, string>(
    (db.prepare('SELECT name, checksum FROM schema_migrations').all() as AppliedMigration[]).map(
      (m) => [m.name, m.checksum],
    ),
  );

  const ran: string[] = [];
  for (const file of files) {
    const sql = readFileSync(path.join(dir, file), 'utf8');
    const checksum = createHash('sha256').update(sql).digest('hex');
    const known = applied.get(file);
    if (known !== undefined) {
      if (known !== checksum) {
        throw new Error(
          `Migration ${file} changed after it was applied. ` +
            `Revert the edit and add a new migration instead.`,
        );
      }
      continue;
    }
    db.transaction(() => {
      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations (name, checksum, applied_at) VALUES (?, ?, ?)').run(
        file,
        checksum,
        new Date().toISOString(),
      );
    })();
    ran.push(file);
  }
  return ran;
}

export function defaultMigrationsDir(): string {
  // Resolves to <repo>/migrations from both src/ (tsx, vitest) and dist/.
  return path.resolve(import.meta.dirname, '../../migrations');
}
