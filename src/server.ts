import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fastifyCookie from '@fastify/cookie';
import fastifyHelmet from '@fastify/helmet';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import type { Config } from './config/index.js';
import { CouchError, type CouchClient } from './couch/client.js';
import type { AppDatabase } from './db/index.js';
import { authGuard } from './plugins/authGuard.js';
import { authRoutes } from './routes/auth.js';
import { backupRoutes } from './routes/backups.js';
import { deviceRoutes } from './routes/devices.js';
import { eventRoutes } from './routes/events.js';
import { healthRoutes } from './routes/health.js';
import { inviteRoutes } from './routes/invites.js';
import { serverRoutes } from './routes/server.js';
import { vaultRoutes } from './routes/vaults.js';
import { PasswordPolicyError } from './services/auth.js';
import { ConfirmTokenService } from './services/confirmTokens.js';
import type { HealthMonitor } from './services/health.js';

declare module 'fastify' {
  interface FastifyInstance {
    config: Config;
    db: AppDatabase;
    masterKey: Buffer;
    couch: CouchClient;
    health: HealthMonitor;
    confirmTokens: ConfirmTokenService;
  }
}

export interface ServerDeps {
  config: Config;
  db: AppDatabase;
  masterKey: Buffer;
  couch: CouchClient;
  health: HealthMonitor;
}

export async function buildServer(deps: ServerDeps): Promise<FastifyInstance> {
  const server = Fastify({
    logger: {
      level: deps.config.logLevel,
    },
    trustProxy: deps.config.trustProxy,
  });

  server.decorate('config', deps.config);
  server.decorate('db', deps.db);
  server.decorate('masterKey', deps.masterKey);
  server.decorate('couch', deps.couch);
  server.decorate('health', deps.health);
  server.decorate('confirmTokens', new ConfirmTokenService());

  await server.register(fastifyCookie);
  await server.register(fastifyHelmet, {
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        'default-src': ["'self'"],
        'script-src': ["'self'"],
        'style-src': ["'self'"],
        'connect-src': ["'self'"],
        'img-src': ["'self'", 'data:'],
        'base-uri': ["'self'"],
        'form-action': ["'self'"],
        'frame-ancestors': ["'none'"],
        'object-src': ["'none'"],
      },
    },
    strictTransportSecurity: { maxAge: 31536000, includeSubDomains: false },
  });

  server.setErrorHandler((err, request, reply) => {
    if (err instanceof ZodError) {
      const detail = err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
      return reply.code(400).send({ error: `Invalid request: ${detail}` });
    }
    if (err instanceof PasswordPolicyError) {
      return reply.code(400).send({ error: err.message });
    }
    if (err instanceof CouchError) {
      // Upstream failure, and the message is already sanitized; the UI can
      // show it as-is (e.g. "CouchDB PUT /_users/... failed: 404 ...").
      request.log.error(err);
      return reply.code(502).send({
        error: `${err.message}. Check the CouchDB server page for configuration problems.`,
      });
    }
    const httpError = err as { statusCode?: number; message?: string };
    if (httpError.statusCode !== undefined && httpError.statusCode < 500) {
      return reply.code(httpError.statusCode).send({ error: httpError.message });
    }
    request.log.error(err);
    return reply.code(500).send({ error: 'Internal error. Check the server logs.' });
  });

  await server.register(
    async (api) => {
      authGuard(api);
      api.register(healthRoutes);
      api.register(authRoutes, { prefix: '/auth' });
      api.register(serverRoutes);
      api.register(vaultRoutes);
      api.register(deviceRoutes);
      api.register(backupRoutes);
      api.register(eventRoutes);
    },
    { prefix: '/api/v1' },
  );

  // Public invite pages live at the root so invite URLs stay short; they
  // authenticate by token and enforce their own rate limit and HTTPS check.
  await server.register(inviteRoutes);

  // In production the SPA is served from web/dist; in dev Vite serves it.
  const webDist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../web/dist');
  if (existsSync(webDist)) {
    await server.register(fastifyStatic, { root: webDist });
    // Stray browser paths land on the app, not a JSON 404. API and invite
    // routes keep their own 404s (invites must stay indistinguishable).
    server.setNotFoundHandler((request, reply) => {
      const isPage =
        request.method === 'GET' &&
        !request.url.startsWith('/api/') &&
        !request.url.startsWith('/invite/') &&
        (request.headers.accept ?? '').includes('text/html');
      if (isPage) {
        return reply.redirect('/');
      }
      return reply
        .code(404)
        .send({ error: `${request.method} ${request.url} is not a known route.` });
    });
  }

  return server;
}
