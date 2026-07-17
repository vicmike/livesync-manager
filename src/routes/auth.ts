import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  createSession,
  destroyOtherSessions,
  destroySession,
  isSetupRequired,
  setAdminPassword,
  verifyAdminPassword,
} from '../services/auth.js';
import { recordEvent } from '../services/events.js';

export const SESSION_COOKIE = 'lsc_session';

const credentialsSchema = z.object({ password: z.string() });

const ATTEMPT_LIMIT = 10;
const ATTEMPT_WINDOW_MS = 15 * 60 * 1000;

export function authRoutes(server: FastifyInstance): void {
  // Failed-attempt throttle per client IP. In-process is enough: this is a
  // single-instance app (DEPLOYMENT.md) and argon2 verification is expensive.
  const attempts = new Map<string, { count: number; resetAt: number }>();

  function throttled(request: FastifyRequest, reply: FastifyReply): boolean {
    const entry = attempts.get(request.ip);
    if (entry && entry.resetAt > Date.now() && entry.count >= ATTEMPT_LIMIT) {
      const minutes = Math.ceil((entry.resetAt - Date.now()) / 60000);
      void reply.code(429).send({ error: `Too many attempts. Try again in ${minutes} minute(s).` });
      return true;
    }
    return false;
  }

  function recordFailure(ip: string): void {
    const now = Date.now();
    const entry = attempts.get(ip);
    if (!entry || entry.resetAt <= now) {
      attempts.set(ip, { count: 1, resetAt: now + ATTEMPT_WINDOW_MS });
    } else {
      entry.count += 1;
    }
  }

  function startSession(reply: FastifyReply): void {
    const { token, expiresAt } = createSession(server.db);
    void reply.setCookie(SESSION_COOKIE, token, {
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      path: '/',
      expires: expiresAt,
    });
  }

  server.post('/setup', { config: { public: true } }, async (request, reply) => {
    if (throttled(request, reply)) return;
    if (!isSetupRequired(server.db)) {
      return reply.code(409).send({
        error: 'The admin password is already set. Log in instead, or reset it per docs.',
      });
    }
    const { password } = credentialsSchema.parse(request.body);
    await setAdminPassword(server.db, password);
    recordEvent(server.db, { level: 'info', actor: 'admin', message: 'Admin password set' });
    startSession(reply);
    return reply.code(201).send({ authenticated: true });
  });

  server.post('/login', { config: { public: true } }, async (request, reply) => {
    if (throttled(request, reply)) return;
    if (isSetupRequired(server.db)) {
      return reply.code(403).send({
        error: 'No admin password is set yet. Complete first-boot setup at /auth/setup.',
      });
    }
    const { password } = credentialsSchema.parse(request.body);
    if (!(await verifyAdminPassword(server.db, password))) {
      recordFailure(request.ip);
      recordEvent(server.db, {
        level: 'warn',
        actor: 'system',
        message: 'Failed admin login attempt',
        detail: { ip: request.ip },
      });
      return reply.code(401).send({ error: 'Wrong password.' });
    }
    attempts.delete(request.ip);
    recordEvent(server.db, { level: 'info', actor: 'admin', message: 'Admin logged in' });
    startSession(reply);
    return reply.send({ authenticated: true });
  });

  server.post('/password', async (request, reply) => {
    if (throttled(request, reply)) return;
    const { currentPassword, newPassword } = z
      .object({ currentPassword: z.string(), newPassword: z.string() })
      .parse(request.body);
    if (!(await verifyAdminPassword(server.db, currentPassword))) {
      recordFailure(request.ip);
      recordEvent(server.db, {
        level: 'warn',
        actor: 'system',
        message: 'Failed password change attempt (wrong current password)',
        detail: { ip: request.ip },
      });
      return reply.code(401).send({ error: 'Current password is wrong.' });
    }
    attempts.delete(request.ip);
    await setAdminPassword(server.db, newPassword);
    // The old password must stop working everywhere it is logged in.
    destroyOtherSessions(server.db, request.cookies[SESSION_COOKIE] ?? '');
    recordEvent(server.db, {
      level: 'info',
      actor: 'admin',
      message: 'Admin password changed (other sessions logged out)',
    });
    return reply.send({ ok: true });
  });

  server.post('/logout', async (request, reply) => {
    const token = request.cookies[SESSION_COOKIE];
    if (token) {
      destroySession(server.db, token);
    }
    void reply.clearCookie(SESSION_COOKIE, { path: '/' });
    recordEvent(server.db, { level: 'info', actor: 'admin', message: 'Admin logged out' });
    return reply.send({ authenticated: false });
  });

  server.get('/session', { config: { public: true } }, async (request) => {
    return {
      setupRequired: isSetupRequired(server.db),
      authenticated: request.session !== undefined,
      ...(request.session ? { session: request.session } : {}),
    };
  });
}
