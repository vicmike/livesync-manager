import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  addDevice,
  getDevice,
  listDevices,
  markDeviceConnected,
  reinviteDevice,
  renameDevice,
  revokeConsequences,
  revokeDevice,
  type DeviceServiceDeps,
} from '../services/devices.js';
import { getVault } from '../services/vaults.js';

const addSchema = z.object({
  name: z.string(),
  platform: z.enum(['desktop', 'ios', 'android', 'unknown']).optional(),
});
const renameSchema = z.object({ name: z.string() });
const revokeSchema = z.object({ confirmToken: z.string() });

export function deviceRoutes(server: FastifyInstance): void {
  const deps: DeviceServiceDeps = {
    db: server.db,
    couch: server.couch,
    masterKey: server.masterKey,
    config: server.config,
  };

  server.get('/vaults/:id/devices', async (request) => {
    const { id } = request.params as { id: string };
    getVault(server.db, id);
    return listDevices(server.db, id);
  });

  server.post('/vaults/:id/devices', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = addSchema.parse(request.body);
    const result = await addDevice(deps, id, body);
    return reply.code(201).send(result);
  });

  server.patch('/devices/:id', async (request) => {
    const { id } = request.params as { id: string };
    const { name } = renameSchema.parse(request.body);
    return renameDevice(server.db, id, name);
  });

  server.post('/devices/:id/connected', async (request) => {
    const { id } = request.params as { id: string };
    return markDeviceConnected(server.db, id);
  });

  server.post('/devices/:id/reinvite', async (request) => {
    const { id } = request.params as { id: string };
    return reinviteDevice(deps, id);
  });

  server.post('/devices/:id/revoke', async (request, reply) => {
    const { id } = request.params as { id: string };
    const device = getDevice(server.db, id);
    if (device.status === 'revoked') {
      return reply.code(409).send({ error: `${device.name} is already revoked.` });
    }

    const { dryRun } = request.query as { dryRun?: string };
    if (dryRun === '1') {
      return {
        confirmToken: server.confirmTokens.issue('device-revoke', id),
        consequences: revokeConsequences(server.db, id),
      };
    }

    const { confirmToken } = revokeSchema.parse(request.body);
    if (!server.confirmTokens.consume('device-revoke', id, confirmToken)) {
      return reply.code(409).send({
        error:
          'Confirmation token is missing, expired, or for a different operation. ' +
          'Request a new one with ?dryRun=1 and review the consequences again.',
      });
    }
    return revokeDevice(deps, id);
  });
}
