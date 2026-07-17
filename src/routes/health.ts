import type { FastifyInstance } from 'fastify';

// Unauthenticated probe target (DEPLOYMENT.md). Returns the cached result
// of the health monitor's last poll, never a live CouchDB call.
export function healthRoutes(server: FastifyInstance): void {
  server.get('/health', { config: { public: true } }, () => server.health.snapshot());
}
