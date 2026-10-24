import type { CouchClient } from '../couch/client.js';
import { probePublicUrl, type FetchLike, type PublicUrlProbe } from './publicUrlProbe.js';
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
  /**
   * The devices' CouchDB URL (COUCHDB_PUBLIC_URL) probed from the manager
   * with each LiveSync origin (LIVESYNC_INTEGRATION.md § 2). Separate from
   * `config`: a reverse proxy can break every device while CouchDB's own
   * settings are perfect, and vice versa.
   */
  publicUrl:
    PublicUrlProbe | { status: 'unknown'; url: string | null; checkedAt: null; error?: string };
  checkedAt: string | null;
}

export interface HealthMonitorOptions {
  /** COUCHDB_PUBLIC_URL; the probe is skipped (status unknown) when absent. */
  publicUrl?: string;
  fetchImpl?: FetchLike;
}

/**
 * Polls CouchDB on an interval and caches the result so GET /health stays
 * cheap and never blocks on CouchDB (DEPLOYMENT.md runtime contract).
 */
export class HealthMonitor {
  private cache: HealthSnapshot;
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly couch: CouchClient,
    private readonly options: HealthMonitorOptions = {},
  ) {
    this.cache = {
      status: 'unknown',
      couchdb: { reachable: false },
      config: { status: 'unknown', checkedAt: null },
      publicUrl: { status: 'unknown', url: options.publicUrl ?? null, checkedAt: null },
      checkedAt: null,
    };
  }

  snapshot(): HealthSnapshot {
    return this.cache;
  }

  private async probe(): Promise<HealthSnapshot['publicUrl']> {
    if (!this.options.publicUrl) {
      return {
        status: 'unknown',
        url: null,
        checkedAt: null,
        error: 'COUCHDB_PUBLIC_URL is not configured, so the devices’ URL was not probed.',
      };
    }
    try {
      return await probePublicUrl(this.options.publicUrl, {
        ...(this.options.fetchImpl ? { fetchImpl: this.options.fetchImpl } : {}),
      });
    } catch (err) {
      return {
        status: 'unknown',
        url: this.options.publicUrl,
        checkedAt: null,
        error: `Could not probe COUCHDB_PUBLIC_URL: ${(err as Error).message}`,
      };
    }
  }

  async poll(): Promise<HealthSnapshot> {
    const startedAt = Date.now();
    // The devices' URL is independent of the admin URL: probe it even when
    // the admin connection is down, so the two failures are told apart.
    const publicUrl = await this.probe();
    try {
      const info = await this.couch.serverInfo();
      let config: HealthSnapshot['config'];
      try {
        const check = await checkServerConfig(this.couch, info.version);
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
        publicUrl,
        checkedAt: new Date().toISOString(),
      };
    } catch (err) {
      this.cache = {
        status: 'degraded',
        couchdb: { reachable: false, error: (err as Error).message },
        config: { status: 'unknown', checkedAt: null },
        publicUrl,
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
