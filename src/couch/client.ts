// Thin typed wrapper over CouchDB's admin API (docs/ARCHITECTURE.md: plain
// fetch, no client library). Error messages carry method/path/status but
// never the server URL or credentials (SECURITY.md review checklist).

export class CouchError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

export interface CouchClientOptions {
  url: string;
  user: string;
  password: string;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
}

export interface ServerInfo {
  version: string;
  uuid?: string;
}

export interface DatabaseInfo {
  db_name: string;
  doc_count: number;
  doc_del_count: number;
  update_seq: string;
  sizes: { file: number; active: number };
}

export interface SecurityObject {
  admins?: { names?: string[]; roles?: string[] };
  members?: { names?: string[]; roles?: string[] };
}

export interface UserDoc {
  _id: string;
  _rev?: string;
  type: 'user';
  name: string;
  roles: string[];
  password?: string;
}

export interface ReplicationRequest {
  source: string;
  target: string;
  create_target?: boolean;
}

export interface ActiveTask {
  type: string;
  [key: string]: unknown;
}

export class CouchClient {
  private readonly base: string;
  private readonly authorization: string;
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: CouchClientOptions) {
    this.base = options.url.replace(/\/+$/, '');
    this.authorization =
      'Basic ' + Buffer.from(`${options.user}:${options.password}`).toString('base64');
    this.fetchFn = options.fetchFn ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 10_000;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    timeoutMs?: number,
  ): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchFn(this.base + path, {
        method,
        headers: {
          authorization: this.authorization,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(timeoutMs ?? this.timeoutMs),
      });
    } catch (err) {
      throw new CouchError(
        `CouchDB is unreachable (${method} ${path}): ${(err as Error).message}`,
        undefined,
      );
    }
    if (!res.ok) {
      let reason = res.statusText;
      try {
        const parsed = (await res.json()) as { error?: string; reason?: string };
        reason = parsed.reason ?? parsed.error ?? reason;
      } catch {
        // Non-JSON error body; the status line is enough.
      }
      throw new CouchError(`CouchDB ${method} ${path} failed: ${res.status} ${reason}`, res.status);
    }
    return (await res.json()) as T;
  }

  serverInfo(): Promise<ServerInfo> {
    return this.request<ServerInfo>('GET', '/');
  }

  /** Resolves once the node reports initialization complete. */
  up(): Promise<{ status: string }> {
    return this.request<{ status: string }>('GET', '/_up');
  }

  async membershipNode(): Promise<string> {
    // Per-node config needs the node name; discover it rather than
    // assuming _local (docs/LIVESYNC_INTEGRATION.md § 2).
    const membership = await this.request<{ all_nodes: string[] }>('GET', '/_membership');
    return membership.all_nodes[0] ?? '_local';
  }

  listDatabases(): Promise<string[]> {
    return this.request<string[]>('GET', '/_all_dbs');
  }

  async createDatabase(name: string): Promise<void> {
    await this.request('PUT', `/${encodeURIComponent(name)}`);
  }

  async deleteDatabase(name: string): Promise<void> {
    await this.request('DELETE', `/${encodeURIComponent(name)}`);
  }

  databaseInfo(name: string): Promise<DatabaseInfo> {
    return this.request<DatabaseInfo>('GET', `/${encodeURIComponent(name)}`);
  }

  async getConfig(node: string, section: string, key: string): Promise<string | undefined> {
    try {
      return await this.request<string>(
        'GET',
        `/_node/${encodeURIComponent(node)}/_config/${encodeURIComponent(section)}/${encodeURIComponent(key)}`,
      );
    } catch (err) {
      if (err instanceof CouchError && err.status === 404) {
        return undefined;
      }
      throw err;
    }
  }

  async setConfig(node: string, section: string, key: string, value: string): Promise<void> {
    await this.request(
      'PUT',
      `/_node/${encodeURIComponent(node)}/_config/${encodeURIComponent(section)}/${encodeURIComponent(key)}`,
      value,
    );
  }

  async getUser(name: string): Promise<UserDoc | undefined> {
    try {
      return await this.request<UserDoc>(
        'GET',
        `/_users/${encodeURIComponent(`org.couchdb.user:${name}`)}`,
      );
    } catch (err) {
      if (err instanceof CouchError && err.status === 404) {
        return undefined;
      }
      throw err;
    }
  }

  /** Creates the user, or sets a new password if it already exists. */
  async putUser(name: string, password: string): Promise<void> {
    const id = `org.couchdb.user:${name}`;
    const existing = await this.getUser(name);
    const doc: UserDoc = {
      _id: id,
      ...(existing?._rev ? { _rev: existing._rev } : {}),
      type: 'user',
      name,
      roles: [],
      password,
    };
    await this.request('PUT', `/_users/${encodeURIComponent(id)}`, doc);
  }

  async deleteUser(name: string): Promise<void> {
    const existing = await this.getUser(name);
    if (!existing?._rev) {
      return;
    }
    await this.request(
      'DELETE',
      `/_users/${encodeURIComponent(existing._id)}?rev=${encodeURIComponent(existing._rev)}`,
    );
  }

  getSecurity(db: string): Promise<SecurityObject> {
    return this.request<SecurityObject>('GET', `/${encodeURIComponent(db)}/_security`);
  }

  async setSecurity(db: string, security: SecurityObject): Promise<void> {
    await this.request('PUT', `/${encodeURIComponent(db)}/_security`, security);
  }

  getDocument<T>(db: string, id: string): Promise<T & { _id: string; _rev: string }> {
    return this.request('GET', `/${encodeURIComponent(db)}/${encodeURIComponent(id)}`);
  }

  allDocs(
    db: string,
    params: { limit?: number; skip?: number; key?: string } = {},
  ): Promise<{ total_rows: number; rows: { id: string; value: { rev: string } }[] }> {
    const query = new URLSearchParams();
    if (params.limit !== undefined) query.set('limit', String(params.limit));
    if (params.skip !== undefined) query.set('skip', String(params.skip));
    if (params.key !== undefined) query.set('key', JSON.stringify(params.key));
    const suffix = query.size > 0 ? `?${query.toString()}` : '';
    return this.request('GET', `/${encodeURIComponent(db)}/_all_docs${suffix}`);
  }

  async putDocument(db: string, id: string, doc: Record<string, unknown>): Promise<void> {
    await this.request('PUT', `/${encodeURIComponent(db)}/${encodeURIComponent(id)}`, doc);
  }

  replicate(request: ReplicationRequest): Promise<{ ok?: boolean }> {
    // One-shot replication blocks until complete and can far outlive the
    // default timeout on big vaults.
    return this.request('POST', '/_replicate', request, 30 * 60 * 1000);
  }

  activeTasks(): Promise<ActiveTask[]> {
    return this.request<ActiveTask[]>('GET', '/_active_tasks');
  }
}
