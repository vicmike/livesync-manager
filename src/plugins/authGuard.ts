import type { FastifyInstance } from 'fastify';
import { SESSION_COOKIE } from '../routes/auth.js';
import { validateSession, type SessionInfo } from '../services/auth.js';

declare module 'fastify' {
  interface FastifyRequest {
    session?: SessionInfo;
  }

  interface FastifyContextConfig {
    /** Marks a route as reachable without an admin session. */
    public?: boolean;
  }
}

/**
 * Requires an admin session for every route in the calling context unless
 * the route sets `config.public`. Public routes still get `request.session`
 * populated when a valid cookie is present (used by GET /auth/session).
 */
export function authGuard(api: FastifyInstance): void {
  api.decorateRequest('session', undefined);
  api.addHook('onRequest', async (request, reply) => {
    const token = request.cookies[SESSION_COOKIE];
    if (token) {
      const session = validateSession(api.db, token);
      if (session) {
        request.session = session;
      }
    }
    if (request.session === undefined && request.routeOptions.config?.public !== true) {
      return reply.code(401).send({ error: 'Not authenticated. Log in first.' });
    }
  });
}
