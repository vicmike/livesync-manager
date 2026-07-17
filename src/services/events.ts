import { v7 as uuidv7 } from 'uuid';
import type { AppDatabase } from '../db/index.js';

export interface EventInput {
  level: 'info' | 'warn' | 'error';
  actor: 'admin' | 'system';
  message: string;
  vaultId?: string;
  deviceId?: string;
  detail?: Record<string, unknown>;
}

/**
 * Audit log (AGENTS.md: no silent operations). Messages are human-readable;
 * detail holds IDs and machine context, never secret material.
 */
export function recordEvent(db: AppDatabase, event: EventInput): void {
  db.prepare(
    `INSERT INTO events (id, ts, level, actor, vault_id, device_id, message, detail_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    uuidv7(),
    new Date().toISOString(),
    event.level,
    event.actor,
    event.vaultId ?? null,
    event.deviceId ?? null,
    event.message,
    event.detail ? JSON.stringify(event.detail) : null,
  );
}
