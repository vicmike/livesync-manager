import type { FastifyInstance } from 'fastify';
import { checkServerConfig, fixServerConfig } from '../services/serverConfig.js';
import { recordEvent } from '../services/events.js';

export function serverRoutes(server: FastifyInstance): void {
  server.get('/server/config', () => checkServerConfig(server.couch));

  server.post('/server/config/fix', async () => {
    const result = await fixServerConfig(server.couch);
    if (result.applied.length > 0) {
      recordEvent(server.db, {
        level: 'info',
        actor: 'admin',
        message: `Applied ${result.applied.length} CouchDB configuration fix(es)`,
        detail: { applied: result.applied },
      });
    }
    return {
      ...result,
      note:
        result.applied.length > 0
          ? 'Settings applied. If CouchDB is configured declaratively (ConfigMap, baked local.ini), ' +
            'mirror these settings there; runtime changes may not survive a CouchDB restart.'
          : 'Nothing to fix.',
    };
  });
}
