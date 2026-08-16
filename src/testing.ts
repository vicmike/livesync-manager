// Test-only helpers; excluded from the production build (tsconfig.build.json).
import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { loadConfig, type Config } from './config/index.js';
import { CouchClient, CouchError, type SecurityObject } from './couch/client.js';
import { openDatabase } from './db/index.js';
import { defaultMigrationsDir, runMigrations } from './db/migrations.js';
import { buildServer } from './server.js';
import { HealthMonitor } from './services/health.js';

export function makeTestConfig(env: Record<string, string> = {}): Config {
  return loadConfig({
    COUCHDB_ADMIN_URL: 'http://127.0.0.1:5984',
    COUCHDB_ADMIN_USER: 'admin',
    COUCHDB_ADMIN_PASSWORD: 'admin',
    COUCHDB_PUBLIC_URL: 'https://couchdb.example.com',
    PUBLIC_BASE_URL: 'https://livesync.example.com',
    LOG_LEVEL: 'silent',
    ...env,
  });
}

/** In-memory stand-in for the CouchDB operations the app uses in tests. */
export class FakeCouch {
  readonly databases = new Map<
    string,
    {
      docCount: number;
      security: SecurityObject;
      docs: Map<string, { rev: string }>;
      localDocs: Map<string, Record<string, unknown>>;
    }
  >();

  putDocument(name: string, id: string): Promise<void> {
    const db = this.databases.get(name);
    if (!db) {
      return Promise.reject(new CouchError(`CouchDB PUT /${name}/${id} failed: 404`, 404));
    }
    db.docs.set(id, { rev: `1-${id}` });
    db.docCount = db.docs.size;
    return Promise.resolve();
  }

  getDocument(name: string, id: string) {
    const doc = this.databases.get(name)?.docs.get(id);
    if (!doc) {
      return Promise.reject(new CouchError(`CouchDB GET /${name}/${id} failed: 404`, 404));
    }
    return Promise.resolve({ _id: id, _rev: doc.rev });
  }

  allDocs(name: string, params: { limit?: number; skip?: number; key?: string } = {}) {
    const db = this.databases.get(name);
    if (!db) {
      return Promise.reject(new CouchError(`CouchDB GET /${name}/_all_docs failed: 404`, 404));
    }
    let ids = [...db.docs.keys()].sort();
    if (params.key !== undefined) {
      ids = ids.filter((id) => id === params.key);
    }
    ids = ids.slice(params.skip ?? 0, (params.skip ?? 0) + (params.limit ?? ids.length));
    return Promise.resolve({
      total_rows: db.docs.size,
      rows: ids.map((id) => ({ id, value: { rev: db.docs.get(id)!.rev } })),
    });
  }

  replicate(request: { source: string; target: string; create_target?: boolean }) {
    const dbName = (url: string) => decodeURIComponent(url.split('/').at(-1)!);
    const source = this.databases.get(dbName(request.source));
    if (!source) {
      return Promise.reject(
        new CouchError('CouchDB POST /_replicate failed: 404 db_not_found', 404),
      );
    }
    let target = this.databases.get(dbName(request.target));
    if (!target) {
      if (!request.create_target) {
        return Promise.reject(
          new CouchError('CouchDB POST /_replicate failed: 404 db_not_found', 404),
        );
      }
      target = { docCount: 0, security: {}, docs: new Map(), localDocs: new Map() };
      this.databases.set(dbName(request.target), target);
    }
    // Like real CouchDB, replication does not copy _local docs.
    for (const [id, doc] of source.docs) {
      target.docs.set(id, { ...doc });
    }
    target.docCount = target.docs.size;
    return Promise.resolve({ ok: true });
  }

  listLocalDocs(name: string): Promise<string[]> {
    const db = this.databases.get(name);
    if (!db) {
      return Promise.reject(
        new CouchError(`CouchDB GET /${name}/_local_docs failed: 404 not_found`, 404),
      );
    }
    return Promise.resolve([...db.localDocs.keys()]);
  }

  getLocalDoc(name: string, id: string) {
    const doc = this.databases.get(name)?.localDocs.get(id);
    if (!doc) {
      return Promise.reject(new CouchError(`CouchDB GET /${name}/${id} failed: 404`, 404));
    }
    return Promise.resolve({ ...doc, _rev: '0-1' });
  }

  putLocalDoc(name: string, id: string, doc: Record<string, unknown>): Promise<void> {
    const db = this.databases.get(name);
    if (!db) {
      return Promise.reject(new CouchError(`CouchDB PUT /${name}/${id} failed: 404`, 404));
    }
    const { _rev: _ignored, ...content } = doc as { _rev?: string };
    void _ignored;
    db.localDocs.set(id, content);
    return Promise.resolve();
  }
  readonly users = new Map<string, { password: string }>();

  putUser(name: string, password: string): Promise<void> {
    this.users.set(name, { password });
    return Promise.resolve();
  }

  getUser(name: string) {
    const user = this.users.get(name);
    return Promise.resolve(
      user
        ? { _id: `org.couchdb.user:${name}`, type: 'user' as const, name, roles: [] }
        : undefined,
    );
  }

  deleteUser(name: string): Promise<void> {
    this.users.delete(name);
    return Promise.resolve();
  }

  listDatabases(): Promise<string[]> {
    return Promise.resolve([...this.databases.keys()]);
  }

  createDatabase(name: string): Promise<void> {
    if (this.databases.has(name)) {
      return Promise.reject(new CouchError(`CouchDB PUT /${name} failed: 412 file_exists`, 412));
    }
    this.databases.set(name, { docCount: 0, security: {}, docs: new Map(), localDocs: new Map() });
    return Promise.resolve();
  }

  deleteDatabase(name: string): Promise<void> {
    if (!this.databases.delete(name)) {
      return Promise.reject(new CouchError(`CouchDB DELETE /${name} failed: 404 not_found`, 404));
    }
    return Promise.resolve();
  }

  databaseInfo(name: string) {
    const db = this.databases.get(name);
    if (!db) {
      return Promise.reject(new CouchError(`CouchDB GET /${name} failed: 404 not_found`, 404));
    }
    return Promise.resolve({
      db_name: name,
      doc_count: db.docCount,
      doc_del_count: 0,
      update_seq: `${db.docCount}-fake`,
      sizes: { file: 1024 * 1024, active: 1024 },
    });
  }

  setSecurity(name: string, security: SecurityObject): Promise<void> {
    const db = this.databases.get(name);
    if (!db) {
      return Promise.reject(
        new CouchError(`CouchDB PUT /${name}/_security failed: 404 not_found`, 404),
      );
    }
    db.security = security;
    return Promise.resolve();
  }

  getSecurity(name: string): Promise<SecurityObject> {
    const db = this.databases.get(name);
    if (!db) {
      return Promise.reject(
        new CouchError(`CouchDB GET /${name}/_security failed: 404 not_found`, 404),
      );
    }
    return Promise.resolve(db.security);
  }
}

export function asCouchClient(fake: FakeCouch): CouchClient {
  return fake as unknown as CouchClient;
}

/** Inserts a bare device row (the add-device flow itself arrives in M6). */
export function insertTestDevice(
  db: ReturnType<typeof openDatabase>,
  masterKey: Buffer,
  vaultId: string,
  name: string,
): { id: string; couchUsername: string } {
  const id = crypto.randomUUID();
  const couchUsername = `device-${name.toLowerCase()}-${id.slice(0, 8)}`;
  db.prepare(
    `INSERT INTO devices (id, vault_id, name, couch_username, couch_password_enc, status, created_at)
     VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
  ).run(id, vaultId, name, couchUsername, randomBytes(16), new Date().toISOString());
  return { id, couchUsername };
}

export async function makeTestServer(
  overrides: { couch?: CouchClient; env?: Record<string, string> } = {},
): Promise<FastifyInstance> {
  const config = makeTestConfig(overrides.env ?? {});
  const db = openDatabase(':memory:');
  runMigrations(db, defaultMigrationsDir());
  const couch =
    overrides.couch ??
    new CouchClient({
      url: config.couchdb.adminUrl,
      user: config.couchdb.adminUser,
      password: config.couchdb.adminPassword,
    });
  return buildServer({
    config,
    db,
    masterKey: randomBytes(32),
    couch,
    health: new HealthMonitor(couch),
  });
}
