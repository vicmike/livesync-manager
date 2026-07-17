import { readFileSync } from 'node:fs';
import { z } from 'zod';

const configSchema = z.object({
  port: z.coerce.number().int().min(1).max(65535).default(8080),
  host: z.string().default('0.0.0.0'),
  logLevel: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  dataDir: z.string().default('/data'),
  // Base64 of exactly 32 bytes; overrides masterKeyFile when set.
  masterKey: z.string().optional(),
  masterKeyFile: z.string().optional(),
  trustProxy: z.boolean().default(false),
  couchdb: z.object({
    adminUrl: z.url({ error: 'couchdb.adminUrl (COUCHDB_ADMIN_URL) must be a URL' }),
    adminUser: z.string().min(1),
    adminPassword: z.string().min(1),
    publicUrl: z
      .url({ error: 'couchdb.publicUrl (COUCHDB_PUBLIC_URL) must be a URL' })
      .refine((u) => !u.endsWith('/'), {
        error: 'couchdb.publicUrl must not have a trailing slash (it is embedded in setup URIs)',
      }),
  }),
  publicBaseUrl: z.url({ error: 'publicBaseUrl (PUBLIC_BASE_URL) must be a URL' }),
  inviteTtlMinutes: z.coerce.number().int().min(1).max(1440).default(15),
});

export type Config = z.infer<typeof configSchema>;

const envMap: Record<string, string[]> = {
  PORT: ['port'],
  HOST: ['host'],
  LOG_LEVEL: ['logLevel'],
  DATA_DIR: ['dataDir'],
  MASTER_KEY: ['masterKey'],
  MASTER_KEY_FILE: ['masterKeyFile'],
  TRUST_PROXY: ['trustProxy'],
  COUCHDB_ADMIN_URL: ['couchdb', 'adminUrl'],
  COUCHDB_ADMIN_USER: ['couchdb', 'adminUser'],
  COUCHDB_ADMIN_PASSWORD: ['couchdb', 'adminPassword'],
  COUCHDB_PUBLIC_URL: ['couchdb', 'publicUrl'],
  PUBLIC_BASE_URL: ['publicBaseUrl'],
  INVITE_TTL_MINUTES: ['inviteTtlMinutes'],
};

function setPath(target: Record<string, unknown>, path: string[], value: unknown): void {
  let node = target;
  for (const key of path.slice(0, -1)) {
    const next = node[key];
    if (typeof next === 'object' && next !== null) {
      node = next as Record<string, unknown>;
    } else {
      const created: Record<string, unknown> = {};
      node[key] = created;
      node = created;
    }
  }
  node[path.at(-1)!] = value;
}

/**
 * Loads configuration from an optional JSON file (CONFIG_FILE) with
 * environment variables taking precedence (DEPLOYMENT.md § Configuration).
 * Throws with an actionable message listing every problem at once.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  let fromFile: Record<string, unknown> = {};
  const configFile = env.CONFIG_FILE;
  if (configFile) {
    let raw: string;
    try {
      raw = readFileSync(configFile, 'utf8');
    } catch (err) {
      throw new Error(
        `Cannot read config file ${configFile} (from CONFIG_FILE): ${(err as Error).message}`,
        { cause: err },
      );
    }
    try {
      fromFile = z.record(z.string(), z.unknown()).parse(JSON.parse(raw));
    } catch (err) {
      throw new Error(`Config file ${configFile} is not a JSON object`, { cause: err });
    }
  }

  const merged = structuredClone(fromFile);
  // Ensure a missing couchdb block reports each missing field by name
  // rather than one opaque "expected object" error.
  merged.couchdb ??= {};
  for (const [envName, path] of Object.entries(envMap)) {
    const value = env[envName];
    if (value !== undefined && value !== '') {
      // Booleans coerce from strings explicitly; z.coerce.boolean would
      // treat "false" as true.
      const isBool = envName === 'TRUST_PROXY';
      setPath(merged, path, isBool ? value === 'true' || value === '1' : value);
    }
  }

  const parsed = configSchema.safeParse(merged);
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(
      `Invalid configuration:\n${problems}\nSet the corresponding environment variables (see docs/DEPLOYMENT.md) or fix ${configFile ?? 'the config file'}.`,
    );
  }
  return parsed.data;
}
