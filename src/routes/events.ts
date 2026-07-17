import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

const querySchema = z.object({
  vaultId: z.string().optional(),
  level: z.enum(['info', 'warn', 'error']).optional(),
  before: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

interface EventRow {
  id: string;
  ts: string;
  level: string;
  actor: string;
  vault_id: string | null;
  device_id: string | null;
  message: string;
}

export function eventRoutes(server: FastifyInstance): void {
  server.get('/events', async (request) => {
    const query = querySchema.parse(request.query);
    const where: string[] = [];
    const params: string[] = [];
    if (query.vaultId) {
      where.push('vault_id = ?');
      params.push(query.vaultId);
    }
    if (query.level) {
      where.push('level = ?');
      params.push(query.level);
    }
    if (query.before) {
      where.push('ts < ?');
      params.push(query.before);
    }
    const rows = server.db
      .prepare(
        `SELECT id, ts, level, actor, vault_id, device_id, message FROM events
         ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
         ORDER BY ts DESC LIMIT ?`,
      )
      .all(...params, query.limit) as EventRow[];
    return rows.map((r) => ({
      id: r.id,
      ts: r.ts,
      level: r.level,
      actor: r.actor,
      vaultId: r.vault_id,
      deviceId: r.device_id,
      message: r.message,
    }));
  });
}
