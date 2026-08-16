import { randomBytes } from 'node:crypto';
import { v7 as uuidv7 } from 'uuid';
import { encryptSecret } from '../crypto/index.js';
import type { AppDatabase } from '../db/index.js';
import type { DatabaseInfo, SecurityObject } from '../couch/client.js';
import { recordEvent } from './events.js';

// The CouchDB operations vault lifecycle needs; satisfied by CouchClient.
export interface VaultCouch {
  listDatabases(): Promise<string[]>;
  createDatabase(name: string): Promise<void>;
  deleteDatabase(name: string): Promise<void>;
  databaseInfo(name: string): Promise<DatabaseInfo>;
  setSecurity(db: string, security: SecurityObject): Promise<void>;
  getSecurity(db: string): Promise<SecurityObject>;
  putDocument(db: string, id: string, doc: Record<string, unknown>): Promise<void>;
}

// Upstream provisioning stamps this marker in fresh databases (VER = 12 in
// livesync-commonlib; the "obsydian" spelling is upstream's). Plugin 1.0.6+
// uses it to tell an empty-but-valid remote from an unreadable one.
export const LIVESYNC_VERSION_DOC = {
  id: 'obsydian_livesync_version',
  doc: { version: 12, type: 'versioninfo' },
} as const;

/** Members object granting access to exactly the given usernames. */
export function membersSecurity(names: string[]): SecurityObject {
  return {
    admins: { names: [], roles: [] },
    members: { names, roles: ['_admin'] },
  };
}

export function activeDeviceUsernames(db: AppDatabase, vaultId: string): string[] {
  return (
    db
      .prepare("SELECT couch_username FROM devices WHERE vault_id = ? AND status != 'revoked'")
      .all(vaultId) as { couch_username: string }[]
  ).map((r) => r.couch_username);
}

// Per-vault LiveSync settings template (docs/LIVESYNC_INTEGRATION.md § 1),
// mirroring commonlib's PREFERRED_SETTING_SELF_HOSTED plus the behavior flags
// upstream's setup-URI generator sets. Non-secret tweak values only:
// credentials, database name, and the E2EE passphrase are merged in when a
// setup URI is minted. All devices of a vault must share these values or
// clients raise a config-mismatch dialog (plugin 1.0 auto-aligns compatible
// chunk-related differences; joining devices are told to fetch the remote
// config, which adopts the vault's stored tweaks).
export const LIVESYNC_SETTINGS_TEMPLATE = {
  encrypt: true,
  usePathObfuscation: true,
  syncOnStart: true,
  periodicReplication: true,
  syncOnFileOpen: true,
  batchSave: true,
  batch_size: 50,
  batches_limit: 50,
  useHistory: true,
  disableRequestURI: true,
  syncAfterMerge: false,
  syncMaxSizeInMB: 50,
  chunkSplitterVersion: 'v3-rabin-karp',
  usePluginSyncV2: true,
  customChunkSize: 60,
  sendChunksBulkMaxSize: 1,
  concurrencyOfReadChunksOnline: 30,
  minimumIntervalOfReadChunksOnline: 25,
  handleFilenameCaseSensitive: false,
  settingVersion: 10,
  notifyThresholdOfRemoteStorageSize: 800,
} as const;

// No devices exist yet (or the vault is locked): members restricted to the
// _admin role keeps every non-admin out (docs/LIVESYNC_INTEGRATION.md § 3).
export const NO_MEMBERS_SECURITY: SecurityObject = {
  admins: { names: [], roles: [] },
  members: { names: [], roles: ['_admin'] },
};

export interface Vault {
  id: string;
  name: string;
  slug: string;
  couchDbName: string;
  status: 'active' | 'archived' | 'deleting';
  encrypted: boolean;
  locked: boolean;
  createdAt: string;
  archivedAt: string | null;
}

interface VaultRow {
  id: string;
  name: string;
  slug: string;
  couch_db_name: string;
  status: Vault['status'];
  encrypted: number;
  locked: number;
  created_at: string;
  archived_at: string | null;
}

function toVault(row: VaultRow): Vault {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    couchDbName: row.couch_db_name,
    status: row.status,
    encrypted: row.encrypted === 1,
    locked: row.locked === 1,
    createdAt: row.created_at,
    archivedAt: row.archived_at,
  };
}

/** Per-vault settings template; unencrypted vaults sync in plaintext. */
export function settingsTemplate(encrypted: boolean): Record<string, unknown> {
  return {
    ...LIVESYNC_SETTINGS_TEMPLATE,
    encrypt: encrypted,
    usePathObfuscation: encrypted,
    // E2EE algorithm only applies when encryption is on; v2 (HKDF) is the
    // plugin default and what all current devices use.
    ...(encrypted ? { E2EEAlgorithm: 'v2' } : {}),
  };
}

export class VaultError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
  }
}

export function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
  if (!slug) {
    throw new VaultError(
      'The vault name must contain at least one letter or digit (it becomes the database name).',
      400,
    );
  }
  return slug;
}

export interface VaultServiceDeps {
  db: AppDatabase;
  couch: VaultCouch;
  masterKey: Buffer;
}

function validateName(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length === 0 || trimmed.length > 64) {
    throw new VaultError('Vault name must be 1-64 characters.', 400);
  }
  return trimmed;
}

function ensureSlugFree(db: AppDatabase, slug: string): void {
  if (db.prepare('SELECT id FROM vaults WHERE slug = ?').get(slug)) {
    throw new VaultError(
      `A vault with the slug "${slug}" already exists. Choose a more distinct name.`,
      409,
    );
  }
}

export async function createVault(
  deps: VaultServiceDeps,
  name: string,
  options: { encrypted?: boolean } = {},
): Promise<Vault & { e2eePassphrase?: string }> {
  const trimmed = validateName(name);
  const encrypted = options.encrypted ?? true;
  const slug = slugify(trimmed);
  const couchDbName = `vault-${slug}`;

  ensureSlugFree(deps.db, slug);
  // Never overwrite an existing database (AGENTS.md safety rules). Adopting
  // one is the connect-existing flow (adoptVault).
  if ((await deps.couch.listDatabases()).includes(couchDbName)) {
    throw new VaultError(
      `CouchDB already has a database named "${couchDbName}". ` +
        `Pick another vault name, or use "connect existing database" to adopt it.`,
      409,
    );
  }

  // ~192 bits, URL-safe. Shown once at creation; the admin must store it in
  // a password manager (SECURITY.md; losing it means losing note access).
  const e2eePassphrase = encrypted ? randomBytes(24).toString('base64url') : undefined;
  const id = uuidv7();
  const now = new Date().toISOString();

  await deps.couch.createDatabase(couchDbName);
  try {
    await deps.couch.setSecurity(couchDbName, NO_MEMBERS_SECURITY);
    await deps.couch.putDocument(couchDbName, LIVESYNC_VERSION_DOC.id, {
      ...LIVESYNC_VERSION_DOC.doc,
    });
    deps.db
      .prepare(
        `INSERT INTO vaults (id, name, slug, couch_db_name, e2ee_passphrase_enc, settings_json,
                             status, encrypted, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
      )
      .run(
        id,
        trimmed,
        slug,
        couchDbName,
        e2eePassphrase !== undefined
          ? encryptSecret(deps.masterKey, e2eePassphrase, {
              table: 'vaults',
              column: 'e2ee_passphrase_enc',
              rowId: id,
            })
          : Buffer.alloc(0),
        JSON.stringify(settingsTemplate(encrypted)),
        encrypted ? 1 : 0,
        now,
      );
  } catch (err) {
    // The database was created by us seconds ago and holds nothing yet;
    // removing it is the only safe automatic rollback in this app.
    await deps.couch.deleteDatabase(couchDbName).catch(() => {});
    throw err;
  }

  recordEvent(deps.db, {
    level: 'info',
    actor: 'admin',
    message: encrypted ? `Created vault ${trimmed}` : `Created vault ${trimmed} (unencrypted)`,
    vaultId: id,
  });
  return { ...toVault(getVaultRow(deps.db, id)!), ...(e2eePassphrase ? { e2eePassphrase } : {}) };
}

/**
 * Adopts an existing LiveSync CouchDB database (M10). Nothing on the server
 * is modified. In particular the existing _security object stays untouched,
 * so devices using legacy shared credentials keep syncing. Whether the
 * database really belongs to LiveSync can only be checked heuristically
 * (content docs are obfuscated), so adoption verifies existence and warns
 * through the returned docCount instead of guessing.
 */
export async function adoptVault(
  deps: VaultServiceDeps,
  input: {
    name: string;
    couchDbName: string;
    encrypted: boolean;
    e2eePassphrase?: string | undefined;
  },
): Promise<Vault & { docCount: number }> {
  const trimmed = validateName(input.name);
  const slug = slugify(trimmed);
  ensureSlugFree(deps.db, slug);

  if (
    deps.db.prepare('SELECT id FROM vaults WHERE couch_db_name = ?').get(input.couchDbName) !==
    undefined
  ) {
    throw new VaultError(`"${input.couchDbName}" is already managed by another vault.`, 409);
  }
  if (input.encrypted && !input.e2eePassphrase) {
    throw new VaultError(
      'The vault encryption passphrase is required to adopt an encrypted database. ' +
        'Future invites must embed it.',
      400,
    );
  }

  let info;
  try {
    info = await deps.couch.databaseInfo(input.couchDbName);
  } catch (err) {
    throw new VaultError(
      `CouchDB has no database named "${input.couchDbName}" (${(err as Error).message}).`,
      404,
    );
  }

  const id = uuidv7();
  deps.db
    .prepare(
      `INSERT INTO vaults (id, name, slug, couch_db_name, e2ee_passphrase_enc, settings_json,
                           status, encrypted, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
    )
    .run(
      id,
      trimmed,
      slug,
      input.couchDbName,
      input.e2eePassphrase
        ? encryptSecret(deps.masterKey, input.e2eePassphrase, {
            table: 'vaults',
            column: 'e2ee_passphrase_enc',
            rowId: id,
          })
        : Buffer.alloc(0),
      JSON.stringify(settingsTemplate(input.encrypted)),
      input.encrypted ? 1 : 0,
      new Date().toISOString(),
    );
  recordEvent(deps.db, {
    level: 'info',
    actor: 'admin',
    message: `Adopted existing database ${input.couchDbName} as vault ${trimmed}`,
    vaultId: id,
  });
  return { ...toVault(getVaultRow(deps.db, id)!), docCount: info.doc_count };
}

/** CouchDB databases not managed by any vault and not internal (adoption candidates). */
export async function listAdoptableDatabases(
  deps: VaultServiceDeps,
): Promise<{ name: string; docCount: number }[]> {
  const managed = new Set(
    (deps.db.prepare('SELECT couch_db_name FROM vaults').all() as { couch_db_name: string }[]).map(
      (r) => r.couch_db_name,
    ),
  );
  const names = (await deps.couch.listDatabases()).filter(
    (name) => !name.startsWith('_') && !name.startsWith('bk-') && !managed.has(name),
  );
  const result = [];
  for (const name of names) {
    const info = await deps.couch.databaseInfo(name);
    result.push({ name, docCount: info.doc_count });
  }
  return result;
}

function getVaultRow(db: AppDatabase, id: string): VaultRow | undefined {
  return db.prepare('SELECT * FROM vaults WHERE id = ?').get(id) as VaultRow | undefined;
}

export function getVault(db: AppDatabase, id: string): Vault {
  const row = getVaultRow(db, id);
  if (!row) {
    throw new VaultError('Vault not found.', 404);
  }
  return toVault(row);
}

export function listVaults(db: AppDatabase, includeArchived: boolean): Vault[] {
  const rows = includeArchived
    ? (db.prepare('SELECT * FROM vaults ORDER BY created_at').all() as VaultRow[])
    : (db
        .prepare("SELECT * FROM vaults WHERE status != 'archived' ORDER BY created_at")
        .all() as VaultRow[]);
  return rows.map(toVault);
}

export interface VaultDetail extends Vault {
  deviceCount: number;
  lastBackup: { finishedAt: string; status: string } | null;
  couch: { docCount: number; updateSeq: string; sizeBytes: number } | { error: string };
  /** _security members not managed by this app (legacy shared credentials on adopted vaults). */
  legacyMembers: string[];
}

export async function getVaultDetail(deps: VaultServiceDeps, id: string): Promise<VaultDetail> {
  const vault = getVault(deps.db, id);
  const { n: deviceCount } = deps.db
    .prepare("SELECT count(*) n FROM devices WHERE vault_id = ? AND status != 'revoked'")
    .get(id) as { n: number };
  const lastBackup =
    (deps.db
      .prepare(
        `SELECT finished_at AS finishedAt, status FROM backups
         WHERE vault_id = ? AND finished_at IS NOT NULL ORDER BY finished_at DESC LIMIT 1`,
      )
      .get(id) as { finishedAt: string; status: string } | undefined) ?? null;
  let couch: VaultDetail['couch'];
  try {
    const info = await deps.couch.databaseInfo(vault.couchDbName);
    couch = {
      docCount: info.doc_count,
      updateSeq: info.update_seq,
      sizeBytes: info.sizes.file,
    };
  } catch (err) {
    couch = { error: (err as Error).message };
  }
  let legacyMembers: string[] = [];
  try {
    const managed = new Set(
      (
        deps.db.prepare('SELECT couch_username FROM devices WHERE vault_id = ?').all(id) as {
          couch_username: string;
        }[]
      ).map((r) => r.couch_username),
    );
    const security = await deps.couch.getSecurity(vault.couchDbName);
    legacyMembers = (security.members?.names ?? []).filter((n) => !managed.has(n));
  } catch {
    // CouchDB unreachable; the couch field already carries the error.
  }
  return { ...vault, deviceCount, lastBackup, couch, legacyMembers };
}

/**
 * Removes a legacy (unmanaged) member from the vault's _security. This is the last
 * step of migrating an adopted vault to per-device users. Any device still
 * using that credential stops syncing.
 */
export async function removeLegacyMember(
  deps: VaultServiceDeps,
  id: string,
  member: string,
): Promise<void> {
  const vault = getVault(deps.db, id);
  const security = await deps.couch.getSecurity(vault.couchDbName);
  const names = security.members?.names ?? [];
  if (!names.includes(member)) {
    throw new VaultError(`"${member}" is not a member of ${vault.couchDbName}.`, 404);
  }
  await deps.couch.setSecurity(vault.couchDbName, {
    admins: security.admins ?? { names: [], roles: [] },
    members: { names: names.filter((n) => n !== member), roles: security.members?.roles ?? [] },
  });
  recordEvent(deps.db, {
    level: 'warn',
    actor: 'admin',
    message: `Removed legacy member ${member} from vault ${vault.name}`,
    vaultId: id,
  });
}

/**
 * The emergency brake (M9): locking swaps _security to the admin-only
 * sentinel so no device can read or write; unlocking rebuilds members from
 * the non-revoked device list. Used standalone and by the restore swap.
 */
export async function setVaultLocked(
  deps: VaultServiceDeps,
  id: string,
  locked: boolean,
): Promise<Vault> {
  const vault = getVault(deps.db, id);
  if (vault.locked === locked) {
    return vault;
  }
  await deps.couch.setSecurity(
    vault.couchDbName,
    locked ? NO_MEMBERS_SECURITY : membersSecurity(activeDeviceUsernames(deps.db, id)),
  );
  deps.db.prepare('UPDATE vaults SET locked = ? WHERE id = ?').run(locked ? 1 : 0, id);
  recordEvent(deps.db, {
    level: 'warn',
    actor: 'admin',
    message: locked
      ? `Locked vault ${vault.name}: devices can no longer read or write`
      : `Unlocked vault ${vault.name}: device access restored`,
    vaultId: id,
  });
  return getVault(deps.db, id);
}

export function renameVault(db: AppDatabase, id: string, name: string): Vault {
  const vault = getVault(db, id);
  const trimmed = name.trim();
  if (trimmed.length === 0 || trimmed.length > 64) {
    throw new VaultError('Vault name must be 1-64 characters.', 400);
  }
  db.prepare('UPDATE vaults SET name = ? WHERE id = ?').run(trimmed, id);
  recordEvent(db, {
    level: 'info',
    actor: 'admin',
    message: `Renamed vault ${vault.name} to ${trimmed}`,
    vaultId: id,
  });
  return getVault(db, id);
}

export function setVaultArchived(db: AppDatabase, id: string, archived: boolean): Vault {
  const vault = getVault(db, id);
  if (archived && vault.status === 'active') {
    db.prepare("UPDATE vaults SET status = 'archived', archived_at = ? WHERE id = ?").run(
      new Date().toISOString(),
      id,
    );
    recordEvent(db, {
      level: 'info',
      actor: 'admin',
      message: `Archived vault ${vault.name}`,
      vaultId: id,
    });
  } else if (!archived && vault.status === 'archived') {
    db.prepare("UPDATE vaults SET status = 'active', archived_at = NULL WHERE id = ?").run(id);
    recordEvent(db, {
      level: 'info',
      actor: 'admin',
      message: `Unarchived vault ${vault.name}`,
      vaultId: id,
    });
  }
  return getVault(db, id);
}

export async function deleteVaultConsequences(
  deps: VaultServiceDeps,
  id: string,
): Promise<string[]> {
  const vault = getVault(deps.db, id);
  const detail = await getVaultDetail(deps, id);
  const consequences = [
    'error' in detail.couch
      ? `Database ${vault.couchDbName} will be permanently deleted from CouchDB (size unknown: CouchDB is unreachable)`
      : `Database ${vault.couchDbName} (${detail.couch.docCount.toLocaleString()} docs, ` +
        `${(detail.couch.sizeBytes / 1024 / 1024).toFixed(1)} MB) will be permanently deleted from CouchDB`,
    ...(detail.deviceCount > 0
      ? [`${detail.deviceCount} device(s) will stop syncing and their credentials will be removed`]
      : []),
    `A final snapshot (bk-${vault.couchDbName}-<timestamp>) will be taken first and left on ` +
      'CouchDB outside the app. Delete it there when no longer needed. ' +
      'Pass backupFirst: false to skip it; then nothing survives deletion.',
  ];
  return consequences;
}

export async function deleteVault(deps: VaultServiceDeps, id: string): Promise<void> {
  const vault = getVault(deps.db, id);
  // CouchDB first: if this fails, the metadata (and the data) both survive.
  // The reverse order could orphan a live database with no record of it.
  try {
    await deps.couch.deleteDatabase(vault.couchDbName);
  } catch (err) {
    if ((err as { status?: number }).status !== 404) {
      throw err;
    }
  }
  deps.db.transaction(() => {
    deps.db.prepare('DELETE FROM invites WHERE vault_id = ?').run(id);
    deps.db.prepare('DELETE FROM devices WHERE vault_id = ?').run(id);
    deps.db.prepare('DELETE FROM backups WHERE vault_id = ?').run(id);
    deps.db.prepare('DELETE FROM health_snapshots WHERE vault_id = ?').run(id);
    deps.db.prepare('DELETE FROM vaults WHERE id = ?').run(id);
  })();
  recordEvent(deps.db, {
    level: 'warn',
    actor: 'admin',
    message: `Deleted vault ${vault.name} and its database ${vault.couchDbName}`,
    vaultId: id,
  });
}
