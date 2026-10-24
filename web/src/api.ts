export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api/v1${path}`, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  const text = await res.text();
  const json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  if (!res.ok) {
    throw new ApiError((json.error as string) ?? res.statusText, res.status);
  }
  return json as T;
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body),
  patch: <T>(path: string, body: unknown) => request<T>('PATCH', path, body),
  put: <T>(path: string, body: unknown) => request<T>('PUT', path, body),
  delete: <T>(path: string, body?: unknown) => request<T>('DELETE', path, body),
};

export interface Session {
  setupRequired: boolean;
  authenticated: boolean;
}

export interface OriginProbe {
  origin: string;
  ok: boolean;
  httpStatus: number | null;
  allowOrigin: string | null;
  allowCredentials: string | null;
  problems: string[];
}

export interface PublicUrlProbe {
  status: 'ok' | 'warn' | 'fail' | 'unknown';
  url: string | null;
  scheme?: string;
  server?: string | null;
  origins?: OriginProbe[];
  problems?: string[];
  checkedAt: string | null;
  error?: string;
}

export interface Health {
  status: 'ok' | 'degraded' | 'unknown';
  couchdb: { reachable: boolean; version?: string; latencyMs?: number; error?: string };
  config: { status: 'ok' | 'drifted' | 'unknown'; checkedAt: string | null; error?: string };
  /** The devices' CouchDB URL probed with each LiveSync origin; separate from `config`. */
  publicUrl: PublicUrlProbe;
  checkedAt: string | null;
}

export interface Vault {
  id: string;
  name: string;
  slug: string;
  couchDbName: string;
  status: 'active' | 'archived' | 'deleting';
  encrypted: boolean;
  /** Uses an independent ID key; devices need Self-hosted LiveSync 1.0.33 or newer. */
  idDerivation: boolean;
  locked: boolean;
  createdAt: string;
  archivedAt: string | null;
}

export interface VaultDetail extends Vault {
  deviceCount: number;
  lastBackup: { finishedAt: string; status: string } | null;
  couch: { docCount: number; updateSeq: string; sizeBytes: number } | { error: string };
  legacyMembers: string[];
}

export interface AdoptableDatabase {
  name: string;
  docCount: number;
}

export interface RestoreResult {
  restoredDbName: string;
  docCount: number;
}

export interface SwapResult {
  docCount: number;
  preSwapBackup: string;
}

export interface VaultHealth {
  vaultId: string;
  couch: { docCount: number; updateSeq: string; sizeBytes: number } | { error: string };
  devices: {
    id: string;
    name: string;
    status: string;
    firstConnected: string | null;
    access: 'configured' | 'drifted' | 'unknown';
  }[];
  clients: {
    milestone: 'present' | 'absent' | 'unavailable';
    total: number;
    minRecommendedPluginVersion: string;
    outdated: { nodeId: string; label: string; pluginVersion: string | null }[];
  };
  backup: {
    lastFinishedAt: string | null;
    lastVerifiedAt: string | null;
    lastStatus: string | null;
  };
  warnings: string[];
}

/** A LiveSync client observed in the vault's milestone document. */
export interface VaultNode {
  vaultId: string;
  nodeId: string;
  label: string;
  accepted: boolean;
  deviceName: string | null;
  vaultName: string | null;
  pluginVersion: string | null;
  appVersion: string | null;
  platform: string | null;
  lastConnected: string | null;
  firstSeen: string;
  lastObserved: string;
  outdated: boolean;
  device: { id: string; name: string } | null;
}

export interface VaultNodes {
  vaultId: string;
  milestone: 'present' | 'absent' | 'unavailable';
  locked: boolean;
  error?: string;
  minRecommendedPluginVersion: string;
  nodes: VaultNode[];
}

export interface Device {
  id: string;
  vaultId: string;
  name: string;
  platform: string | null;
  couchUsername: string;
  status: 'pending' | 'active' | 'revoked';
  firstConnected: string | null;
  lastSeen: string | null;
  revokedAt: string | null;
  createdAt: string;
}

export interface Invite {
  url: string;
  urlQr: string;
  uriPassphrase: string;
  expiresAt: string;
}

export interface Backup {
  id: string;
  vaultId: string;
  kind: 'manual' | 'scheduled';
  location: string;
  status: 'running' | 'complete' | 'verified' | 'failed';
  docCount: number | null;
  sizeBytes: number | null;
  startedAt: string;
  finishedAt: string | null;
  verifiedAt: string | null;
}

export interface ConfigCheck {
  section: string;
  key: string;
  expected: string;
  actual: string | undefined;
  ok: boolean;
  /** false: informational (a legacy key the server ignores); never fails the check. */
  required: boolean;
  note?: string;
}

export interface ConfigCheckResult {
  node: string;
  ok: boolean;
  couchdbVersion: string | null;
  checks: ConfigCheck[];
}

export interface ConfigFixResult extends ConfigCheckResult {
  applied: { section: string; key: string }[];
  persistence: 'unknown';
  recheck: ConfigCheckResult;
  note: string;
}

export interface EventEntry {
  id: string;
  ts: string;
  level: 'info' | 'warn' | 'error';
  actor: string;
  vaultId: string | null;
  deviceId: string | null;
  message: string;
}

export interface DryRun {
  confirmToken: string;
  consequences: string[];
}
