import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  deleteBackup,
  deleteBackupConsequences,
  getBackup,
  listBackups,
  runBackup,
  verifyBackup,
  type BackupServiceDeps,
} from '../services/backups.js';
import {
  restorePreview,
  restoreSwap,
  restoreSwapConsequences,
  restoreToNewDb,
  type RestoreDeps,
} from '../services/restore.js';
import { getVault } from '../services/vaults.js';

const swapSchema = z.object({ confirmToken: z.string() });

const deleteSchema = z.object({ confirmToken: z.string() });

export function backupRoutes(server: FastifyInstance): void {
  const deps: BackupServiceDeps = { db: server.db, couch: server.couch, config: server.config };

  server.get('/vaults/:id/backups', async (request) => {
    const { id } = request.params as { id: string };
    getVault(server.db, id);
    return listBackups(server.db, id);
  });

  server.post('/vaults/:id/backups', async (request, reply) => {
    const { id } = request.params as { id: string };
    getVault(server.db, id);
    const running = server.db
      .prepare("SELECT id FROM backups WHERE vault_id = ? AND status = 'running'")
      .get(id);
    if (running) {
      return reply.code(409).send({ error: 'A backup of this vault is already running.' });
    }
    // Snapshots of large vaults take a while; the request must not block.
    // runBackup inserts the row synchronously before its first await, and
    // failures are audited to the events feed.
    runBackup(deps, id, 'manual').catch(() => {});
    const backup = listBackups(server.db, id)[0];
    return reply.code(202).send(backup);
  });

  server.post('/backups/:id/verify', async (request) => {
    const { id } = request.params as { id: string };
    return verifyBackup(deps, id);
  });

  const restoreDeps: RestoreDeps = { db: server.db, couch: server.couch, config: server.config };

  server.get('/backups/:id/restore/preview', async (request) => {
    const { id } = request.params as { id: string };
    return restorePreview(restoreDeps, id);
  });

  server.post('/backups/:id/restore', async (request) => {
    const { id } = request.params as { id: string };
    return restoreToNewDb(restoreDeps, id);
  });

  server.post('/backups/:id/restore/swap', async (request, reply) => {
    const { id } = request.params as { id: string };
    getBackup(server.db, id);
    const { dryRun } = request.query as { dryRun?: string };
    if (dryRun === '1') {
      return {
        confirmToken: server.confirmTokens.issue('restore-swap', id),
        consequences: await restoreSwapConsequences(restoreDeps, id),
      };
    }
    const { confirmToken } = swapSchema.parse(request.body);
    if (!server.confirmTokens.consume('restore-swap', id, confirmToken)) {
      return reply.code(409).send({
        error:
          'Confirmation token is missing, expired, or for a different operation. ' +
          'Request a new one with ?dryRun=1 and review the consequences again.',
      });
    }
    return restoreSwap(restoreDeps, id);
  });

  server.delete('/backups/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    getBackup(server.db, id);

    const { dryRun } = request.query as { dryRun?: string };
    if (dryRun === '1') {
      return {
        confirmToken: server.confirmTokens.issue('backup-delete', id),
        consequences: deleteBackupConsequences(server.db, id),
      };
    }
    const { confirmToken } = deleteSchema.parse(request.body);
    if (!server.confirmTokens.consume('backup-delete', id, confirmToken)) {
      return reply.code(409).send({
        error:
          'Confirmation token is missing, expired, or for a different operation. ' +
          'Request a new one with ?dryRun=1 and review the consequences again.',
      });
    }
    await deleteBackup(deps, id);
    return { deleted: true };
  });
}
