import type { CouchClient } from '../couch/client.js';

export interface HealthSnapshot {
  status: 'ok' | 'degraded' | 'unknown';
  couchdb: {
    reachable: boolean;
    version?: string;
    latencyMs?: number;
    error?: string;
  };
  checkedAt: string | null;
}

/**
 * Polls CouchDB on an interval and caches the result so GET /health stays
 * cheap and never blocks on CouchDB (DEPLOYMENT.md runtime contract).
 */
export class HealthMonitor {
  private cache: HealthSnapshot = {
    status: 'unknown',
    couchdb: { reachable: false },
    checkedAt: null,
  };
  private timer: NodeJS.Timeout | undefined;

  constructor(private readonly couch: CouchClient) {}

  snapshot(): HealthSnapshot {
    return this.cache;
  }

  async poll(): Promise<HealthSnapshot> {
    const startedAt = Date.now();
    try {
      const info = await this.couch.serverInfo();
      this.cache = {
        status: 'ok',
        couchdb: {
          reachable: true,
          version: info.version,
          latencyMs: Date.now() - startedAt,
        },
        checkedAt: new Date().toISOString(),
      };
    } catch (err) {
      this.cache = {
        status: 'degraded',
        couchdb: { reachable: false, error: (err as Error).message },
        checkedAt: new Date().toISOString(),
      };
    }
    return this.cache;
  }

  start(intervalMs: number): void {
    void this.poll();
    this.timer = setInterval(() => void this.poll(), intervalMs);
    this.timer.unref();
  }

  stop(): void {
    clearInterval(this.timer);
  }
}
