import type { FastifyInstance } from 'fastify';
import type { CouchClient } from '../couch/client.js';
import { checkServerConfig, fixServerConfig } from '../services/serverConfig.js';
import { recordEvent } from '../services/events.js';

// The required keys depend on the CouchDB version (LIVESYNC_INTEGRATION.md
// § 2). An unreadable version falls back to the modern rule set.
async function couchdbVersion(couch: CouchClient): Promise<string | undefined> {
  try {
    return (await couch.serverInfo()).version;
  } catch {
    return undefined;
  }
}

export function serverRoutes(server: FastifyInstance): void {
  server.get('/server/config', async () =>
    checkServerConfig(server.couch, await couchdbVersion(server.couch)),
  );

  server.post('/server/config/fix', async () => {
    const result = await fixServerConfig(server.couch, await couchdbVersion(server.couch));
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
