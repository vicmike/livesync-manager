// Verifies and fixes the CouchDB server settings LiveSync requires
// (docs/LIVESYNC_INTEGRATION.md § 2). Fixes are idempotent PUTs, but they
// may not persist across CouchDB restarts on declaratively managed installs.
// Persistence is always reported as unknown and the UI must say so.
//
// The rules mirror the plugin's own "Check database configuration"
// (upstream utilCheckCouchDB.ts): CouchDB 3.2 moved the authentication and
// CORS switches from the legacy `chttpd_auth` / `httpd` sections to `chttpd`,
// so which keys are required depends on the server version; the two size
// limits are minimums, not exact values; and `cors/origins = *` satisfies the
// origin requirement.

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

/** First CouchDB release that reads `chttpd/require_valid_user` and `chttpd/enable_cors`. */
const MODERN_CONFIG_FROM: [number, number] = [3, 2];

interface Rule {
  section: string;
  key: string;
  /** The value the one-click fix writes. */
  value: string;
  /** `exact`: must equal `value`; `min`: numeric, must be at least `value`. */
  mode: 'exact' | 'min';
  /** Which server generations read this key. */
  appliesTo: 'all' | 'modern' | 'legacy';
}

const RULES: Rule[] = [
  {
    section: 'chttpd',
    key: 'require_valid_user',
    value: 'true',
    mode: 'exact',
    appliesTo: 'modern',
  },
  {
    section: 'chttpd_auth',
    key: 'require_valid_user',
    value: 'true',
    mode: 'exact',
    appliesTo: 'legacy',
  },
  {
    section: 'httpd',
    key: 'WWW-Authenticate',
    value: 'Basic realm="couchdb"',
    mode: 'exact',
    appliesTo: 'all',
  },
  { section: 'httpd', key: 'enable_cors', value: 'true', mode: 'exact', appliesTo: 'legacy' },
  { section: 'chttpd', key: 'enable_cors', value: 'true', mode: 'exact', appliesTo: 'modern' },
  {
    section: 'chttpd',
    key: 'max_http_request_size',
    value: '4294967296',
    mode: 'min',
    appliesTo: 'all',
  },
  {
    section: 'couchdb',
    key: 'max_document_size',
    value: '50000000',
    mode: 'min',
    appliesTo: 'all',
  },
  { section: 'cors', key: 'credentials', value: 'true', mode: 'exact', appliesTo: 'all' },
];

export interface ConfigCheck {
  section: string;
  key: string;
  /** Human-readable requirement ("true", "at least 50000000", "must include ..."). */
  expected: string;
  actual: string | undefined;
  ok: boolean;
  /**
   * false: informational only. A legacy key still set on a CouchDB >= 3.2
   * server is reported so the admin knows it is ignored, but it never fails
   * the check and the fix never touches it.
   */
  required: boolean;
  note?: string;
}

export interface ConfigCheckResult {
  node: string;
  ok: boolean;
  /** The CouchDB version the rules were chosen for; null when unknown. */
  couchdbVersion: string | null;
  checks: ConfigCheck[];
}

/**
 * CouchDB >= 3.2 reads the `chttpd` keys. An unknown version is treated as
 * modern: every supported CouchDB 3.x release today is, and the modern keys
 * are also what upstream's reference `local.ini` sets.
 */
export function isModernCouchDB(version: string | undefined): boolean {
  const match = /^(\d+)\.(\d+)/.exec(version ?? '');
  if (!match) {
    return true;
  }
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return (
    major > MODERN_CONFIG_FROM[0] ||
    (major === MODERN_CONFIG_FROM[0] && minor >= MODERN_CONFIG_FROM[1])
  );
}

function mergedOrigins(actual: string | undefined): string {
  const existing = (actual ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return [...new Set([...existing, ...REQUIRED_CORS_ORIGINS])].join(',');
}

function splitOrigins(actual: string | undefined): string[] {
  return (actual ?? '').split(',').map((s) => s.trim());
}

function originsOk(actual: string | undefined): boolean {
  if (actual?.trim() === '*') {
    return true;
  }
  const existing = splitOrigins(actual);
  return REQUIRED_CORS_ORIGINS.every((origin) => existing.includes(origin));
}

function ruleSatisfied(rule: Rule, actual: string | undefined): boolean {
  if (rule.mode === 'min') {
    const n = Number(actual);
    return actual !== undefined && Number.isFinite(n) && n >= Number(rule.value);
  }
  return actual === rule.value;
}

function expectation(rule: Rule): string {
  return rule.mode === 'min' ? `at least ${rule.value}` : rule.value;
}

function fixValue(section: string, key: string, actual: string | undefined): string | undefined {
  if (section === 'cors' && key === 'origins') {
    return mergedOrigins(actual);
  }
  return RULES.find((r) => r.section === section && r.key === key)?.value;
}

export async function checkServerConfig(
  client: ConfigClient,
  couchdbVersion?: string,
): Promise<ConfigCheckResult> {
  const node = await client.membershipNode();
  const modern = isModernCouchDB(couchdbVersion);
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
      required: true,
    });
  }
  for (const rule of RULES) {
    const actual = await client.getConfig(node, rule.section, rule.key);
    const generation = rule.appliesTo;
    if (generation === 'all' || (generation === 'modern') === modern) {
      checks.push({
        section: rule.section,
        key: rule.key,
        expected: expectation(rule),
        actual,
        ok: ruleSatisfied(rule, actual),
        required: true,
      });
      continue;
    }
    if (generation === 'legacy' && modern && actual !== undefined) {
      // Ignored by this server; shown so nobody wonders why it has no effect.
      const replacement = RULES.find((r) => r.appliesTo === 'modern' && r.key === rule.key)!;
      checks.push({
        section: rule.section,
        key: rule.key,
        expected: expectation(rule),
        actual,
        ok: true,
        required: false,
        note:
          `CouchDB ${couchdbVersion ?? '3.2+'} ignores this legacy key and reads ` +
          `${replacement.section}/${replacement.key} instead. Harmless; it can be removed.`,
      });
    }
    // A modern key on a pre-3.2 server is not read either; nothing to report.
  }
  const origins = await client.getConfig(node, 'cors', 'origins');
  const wildcard = origins?.trim() === '*';
  checks.push({
    section: 'cors',
    key: 'origins',
    expected: `must include ${REQUIRED_CORS_ORIGINS.join(', ')}`,
    actual: origins,
    ok: originsOk(origins),
    required: true,
    ...(wildcard
      ? {
          note:
            'A wildcard admits every origin, which LiveSync accepts. Listing only the origins ' +
            'you need is recommended; the one-click fix never narrows it for you.',
        }
      : {}),
  });
  return {
    node,
    ok: checks.every((c) => c.ok),
    couchdbVersion: couchdbVersion ?? null,
    checks,
  };
}

export interface ConfigFixResult {
  applied: { section: string; key: string }[];
  persistence: 'unknown';
  recheck: ConfigCheckResult;
}

export async function fixServerConfig(
  client: ConfigClient,
  couchdbVersion?: string,
): Promise<ConfigFixResult> {
  const before = await checkServerConfig(client, couchdbVersion);
  const applied: { section: string; key: string }[] = [];
  for (const check of before.checks.filter((c) => c.required && !c.ok)) {
    if (check.section === 'databases') {
      await client.createDatabase(check.key);
    } else {
      const value = fixValue(check.section, check.key, check.actual);
      if (value === undefined) {
        continue;
      }
      await client.setConfig(before.node, check.section, check.key, value);
    }
    applied.push({ section: check.section, key: check.key });
  }
  return {
    applied,
    persistence: 'unknown',
    recheck: await checkServerConfig(client, couchdbVersion),
  };
}
