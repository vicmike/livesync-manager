import type { CouchClient } from '../couch/client.js';
import { checkServerConfig } from './serverConfig.js';

export interface HealthSnapshot {
  status: 'ok' | 'degraded' | 'unknown';
  couchdb: {
    reachable: boolean;
    version?: string;
    latencyMs?: number;
    error?: string;
  };
  config: {
    status: 'ok' | 'drifted' | 'unknown';
    checkedAt: string | null;
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
    config: { status: 'unknown', checkedAt: null },
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
      let config: HealthSnapshot['config'];
      try {
        const check = await checkServerConfig(this.couch);
        config = { status: check.ok ? 'ok' : 'drifted', checkedAt: new Date().toISOString() };
      } catch (err) {
        config = {
          status: 'unknown',
          checkedAt: new Date().toISOString(),
          error: (err as Error).message,
        };
      }
      this.cache = {
        status: 'ok',
        couchdb: {
          reachable: true,
          version: info.version,
          latencyMs: Date.now() - startedAt,
        },
        config,
        checkedAt: new Date().toISOString(),
      };
    } catch (err) {
      this.cache = {
        status: 'degraded',
        couchdb: { reachable: false, error: (err as Error).message },
        config: { status: 'unknown', checkedAt: null },
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
