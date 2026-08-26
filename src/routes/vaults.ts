import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  adoptVault,
  createVault,
  deleteVault,
  deleteVaultConsequences,
  getVaultDetail,
  getVault,
  listAdoptableDatabases,
  listVaults,
  removeLegacyMember,
  renameVault,
  setVaultArchived,
  setVaultLocked,
  type VaultServiceDeps,
} from '../services/vaults.js';
import { runBackup } from '../services/backups.js';
import { getVaultHealth } from '../services/vaultHealth.js';

const createSchema = z.object({ name: z.string(), encrypted: z.boolean().default(true) });
const adoptSchema = z.object({
  name: z.string(),
  couchDbName: z.string(),
  encrypted: z.boolean().default(true),
  e2eePassphrase: z.string().optional(),
});
const removeMemberSchema = z.object({ name: z.string(), confirmToken: z.string() });
const patchSchema = z
  .object({ name: z.string().optional(), archived: z.boolean().optional() })
  .refine((body) => body.name !== undefined || body.archived !== undefined, {
    error: 'Provide "name" to rename and/or "archived" to archive or unarchive.',
  });
const deleteSchema = z.object({
  confirmToken: z.string(),
  typedName: z.string(),
  backupFirst: z.boolean().default(true),
});

export function vaultRoutes(server: FastifyInstance): void {
  const deps: VaultServiceDeps = {
    db: server.db,
    couch: server.couch,
    masterKey: server.masterKey,
  };

  server.get('/vaults', async (request) => {
    const { archived } = request.query as { archived?: string };
    return listVaults(server.db, archived === '1');
  });

  server.post('/vaults', async (request, reply) => {
    const { name, encrypted } = createSchema.parse(request.body);
    const vault = await createVault(deps, name, { encrypted });
    return reply.code(201).send(vault);
  });

  server.get('/vaults/adoptable', async () => listAdoptableDatabases(deps));

  server.post('/vaults/connect', async (request, reply) => {
    const body = adoptSchema.parse(request.body);
    const vault = await adoptVault(deps, body);
    return reply.code(201).send(vault);
  });

  server.post('/vaults/:id/lock', async (request) => {
    const { id } = request.params as { id: string };
    return setVaultLocked(deps, id, true);
  });

  server.post('/vaults/:id/unlock', async (request) => {
    const { id } = request.params as { id: string };
    return setVaultLocked(deps, id, false);
  });

  server.post('/vaults/:id/members/remove', async (request, reply) => {
    const { id } = request.params as { id: string };
    getVault(server.db, id);
    const { dryRun } = request.query as { dryRun?: string };
    if (dryRun === '1') {
      const { name } = z.object({ name: z.string() }).parse(request.body);
      return {
        confirmToken: server.confirmTokens.issue('member-remove', `${id}:${name}`),
        consequences: [
          `"${name}" will be removed from the database's members; any device still using ` +
            'that shared credential stops syncing immediately',
          'This does not delete the CouchDB user itself, only its access to this vault',
        ],
      };
    }
    const body = removeMemberSchema.parse(request.body);
    if (!server.confirmTokens.consume('member-remove', `${id}:${body.name}`, body.confirmToken)) {
      return reply.code(409).send({
        error:
          'Confirmation token is missing, expired, or for a different operation. ' +
          'Request a new one with ?dryRun=1 and review the consequences again.',
      });
    }
    await removeLegacyMember(deps, id, body.name);
    return { removed: true };
  });

  server.get('/vaults/:id', async (request) => {
    const { id } = request.params as { id: string };
    return getVaultDetail(deps, id);
  });

  server.patch('/vaults/:id', async (request) => {
    const { id } = request.params as { id: string };
    const body = patchSchema.parse(request.body);
    let vault = getVault(server.db, id);
    if (body.name !== undefined) {
      vault = renameVault(server.db, id, body.name);
    }
    if (body.archived !== undefined) {
      vault = setVaultArchived(server.db, id, body.archived);
    }
    return vault;
  });

  server.get('/vaults/:id/health', async (request) => {
    const { id } = request.params as { id: string };
    return getVaultHealth({ db: server.db, couch: server.couch }, id);
  });

  server.delete('/vaults/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const vault = getVault(server.db, id);

    const { dryRun } = request.query as { dryRun?: string };
    if (dryRun === '1') {
      return {
        confirmToken: server.confirmTokens.issue('vault-delete', id),
        consequences: await deleteVaultConsequences(deps, id),
      };
    }

    const body = deleteSchema.parse(request.body);
    if (body.typedName !== vault.name) {
      return reply.code(400).send({
        error: `Type the vault name exactly ("${vault.name}") to confirm deletion.`,
      });
    }
    if (!server.confirmTokens.consume('vault-delete', id, body.confirmToken)) {
      return reply.code(409).send({
        error:
          'Confirmation token is missing, expired, or for a different operation. ' +
          'Request a new one with ?dryRun=1 and review the consequences again.',
      });
    }
    if (body.backupFirst) {
      try {
        await runBackup(
          { db: server.db, couch: server.couch, config: server.config },
          id,
          'manual',
        );
      } catch (err) {
        return reply.code(502).send({
          error:
            `The final backup failed (${(err as Error).message}); the vault was NOT deleted. ` +
            'Fix the backup problem, or pass backupFirst: false to delete without one.',
        });
      }
    }
    await deleteVault(deps, id);
    return { deleted: true };
  });
}
