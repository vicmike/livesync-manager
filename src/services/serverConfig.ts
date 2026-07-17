// Verifies and fixes the CouchDB server settings LiveSync requires
// (docs/LIVESYNC_INTEGRATION.md § 2). Fixes are idempotent PUTs, but they
// may not persist across CouchDB restarts on declaratively managed installs.
// Persistence is always reported as unknown and the UI must say so.

export interface ConfigClient {
  membershipNode(): Promise<string>;
  getConfig(node: string, section: string, key: string): Promise<string | undefined>;
  setConfig(node: string, section: string, key: string, value: string): Promise<void>;
  listDatabases(): Promise<string[]>;
  createDatabase(name: string): Promise<void>;
}

// Fresh single-node installs lack the system databases until something
// creates them; device users live in _users (reference/couchdb-init.sh
// creates both).
const SYSTEM_DATABASES = ['_users', '_replicator'];

export const REQUIRED_CORS_ORIGINS = [
  'app://obsidian.md',
  'capacitor://localhost',
  'http://localhost',
];

const EXACT_SETTINGS: { section: string; key: string; value: string }[] = [
  { section: 'chttpd', key: 'require_valid_user', value: 'true' },
  { section: 'chttpd_auth', key: 'require_valid_user', value: 'true' },
  { section: 'httpd', key: 'WWW-Authenticate', value: 'Basic realm="couchdb"' },
  { section: 'httpd', key: 'enable_cors', value: 'true' },
  { section: 'chttpd', key: 'enable_cors', value: 'true' },
  { section: 'chttpd', key: 'max_http_request_size', value: '4294967296' },
  { section: 'couchdb', key: 'max_document_size', value: '50000000' },
  { section: 'cors', key: 'credentials', value: 'true' },
];

export interface ConfigCheck {
  section: string;
  key: string;
  expected: string;
  actual: string | undefined;
  ok: boolean;
}

export interface ConfigCheckResult {
  node: string;
  ok: boolean;
  checks: ConfigCheck[];
}

function mergedOrigins(actual: string | undefined): string {
  const existing = (actual ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return [...new Set([...existing, ...REQUIRED_CORS_ORIGINS])].join(',');
}

function originsOk(actual: string | undefined): boolean {
  const existing = (actual ?? '').split(',').map((s) => s.trim());
  return REQUIRED_CORS_ORIGINS.every((origin) => existing.includes(origin));
}

export async function checkServerConfig(client: ConfigClient): Promise<ConfigCheckResult> {
  const node = await client.membershipNode();
  const checks: ConfigCheck[] = [];
  const databases = await client.listDatabases();
  for (const name of SYSTEM_DATABASES) {
    const exists = databases.includes(name);
    checks.push({
      section: 'databases',
      key: name,
      expected: 'exists',
      actual: exists ? 'exists' : undefined,
      ok: exists,
    });
  }
  for (const { section, key, value } of EXACT_SETTINGS) {
    const actual = await client.getConfig(node, section, key);
    checks.push({ section, key, expected: value, actual, ok: actual === value });
  }
  const origins = await client.getConfig(node, 'cors', 'origins');
  checks.push({
    section: 'cors',
    key: 'origins',
    expected: `must include ${REQUIRED_CORS_ORIGINS.join(', ')}`,
    actual: origins,
    ok: originsOk(origins),
  });
  return { node, ok: checks.every((c) => c.ok), checks };
}

export interface ConfigFixResult {
  applied: { section: string; key: string }[];
  persistence: 'unknown';
  recheck: ConfigCheckResult;
}

export async function fixServerConfig(client: ConfigClient): Promise<ConfigFixResult> {
  const before = await checkServerConfig(client);
  const applied: { section: string; key: string }[] = [];
  for (const check of before.checks.filter((c) => !c.ok)) {
    if (check.section === 'databases') {
      await client.createDatabase(check.key);
    } else {
      const value =
        check.section === 'cors' && check.key === 'origins'
          ? mergedOrigins(check.actual)
          : check.expected;
      await client.setConfig(before.node, check.section, check.key, value);
    }
    applied.push({ section: check.section, key: check.key });
  }
  return { applied, persistence: 'unknown', recheck: await checkServerConfig(client) };
}
