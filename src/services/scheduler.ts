import { runBackup, type BackupServiceDeps } from './backups.js';

const BACKUP_EVERY_MS = 24 * 60 * 60 * 1000;
const TICK_MS = 60 * 60 * 1000;

/**
 * In-process scheduler (ARCHITECTURE.md: no cron dependency). Each hourly
 * tick backs up any active vault whose newest successful backup is older
 * than a day, which also self-heals missed runs after downtime.
 */
export class BackupScheduler {
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly deps: BackupServiceDeps,
    private readonly onError: (err: Error, vaultId: string) => void,
  ) {}

  /** Vault ids due for a scheduled backup. */
  due(now = new Date()): string[] {
    const cutoff = new Date(now.getTime() - BACKUP_EVERY_MS).toISOString();
    return (
      this.deps.db
        .prepare(
          `SELECT v.id FROM vaults v
           WHERE v.status = 'active'
             AND NOT EXISTS (
               SELECT 1 FROM backups b
               WHERE b.vault_id = v.id
                 AND (b.status = 'running'
                      OR (b.status IN ('complete', 'verified') AND b.finished_at > ?)))`,
        )
        .all(cutoff) as { id: string }[]
    ).map((r) => r.id);
  }

  async tick(): Promise<void> {
    for (const vaultId of this.due()) {
      try {
        await runBackup(this.deps, vaultId, 'scheduled');
      } catch (err) {
        // Already audited by runBackup; keep the loop going for other vaults.
        this.onError(err as Error, vaultId);
      }
    }
  }

  start(): void {
    void this.tick();
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    this.timer.unref();
  }

  stop(): void {
    clearInterval(this.timer);
  }
}
