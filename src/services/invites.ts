import { createHash, randomBytes, randomInt } from 'node:crypto';
import { upsertRemoteConfigurationInPlace } from '@vrtmrz/livesync-commonlib/remote-configurations';
import type { ObsidianLiveSyncSettings } from '@vrtmrz/livesync-commonlib/settings';
import QRCode from 'qrcode';
import { v7 as uuidv7 } from 'uuid';
import type { Config } from '../config/index.js';
import { decryptSecret, encryptSecret } from '../crypto/index.js';
import { encryptSetupUri } from '../crypto/setupUri.js';
import type { AppDatabase } from '../db/index.js';
import { recordEvent } from './events.js';

// Invite-passphrase wordlists, from reference/generate_setupuri.ts
// (vrtmrz/obsidian-livesync, MIT). The passphrase is typed by a human on
// the new device, so it stays short: it only protects the URI payload for
// the invite's few-minute, single-use lifetime (SECURITY.md).
const ADJECTIVES = [
  'autumn',
  'hidden',
  'bitter',
  'misty',
  'silent',
  'empty',
  'dry',
  'dark',
  'summer',
  'icy',
  'delicate',
  'quiet',
  'white',
  'cool',
  'spring',
  'winter',
  'patient',
  'twilight',
  'dawn',
  'crimson',
  'wispy',
  'weathered',
  'blue',
  'billowing',
  'broken',
  'cold',
  'damp',
  'falling',
  'frosty',
  'green',
  'long',
  'late',
  'lingering',
  'bold',
  'little',
  'morning',
  'muddy',
  'old',
  'red',
  'rough',
  'still',
  'small',
  'sparkling',
  'shy',
  'wandering',
  'withered',
  'wild',
  'black',
  'young',
  'holy',
  'solitary',
  'fragrant',
  'aged',
  'snowy',
  'proud',
  'floral',
  'restless',
  'divine',
  'polished',
  'ancient',
  'purple',
  'lively',
  'nameless',
];
const NOUNS = [
  'waterfall',
  'river',
  'breeze',
  'moon',
  'rain',
  'wind',
  'sea',
  'morning',
  'snow',
  'lake',
  'sunset',
  'pine',
  'shadow',
  'leaf',
  'dawn',
  'glitter',
  'forest',
  'hill',
  'cloud',
  'meadow',
  'sun',
  'glade',
  'bird',
  'brook',
  'butterfly',
  'bush',
  'dew',
  'dust',
  'field',
  'fire',
  'flower',
  'firefly',
  'feather',
  'grass',
  'haze',
  'mountain',
  'night',
  'pond',
  'darkness',
  'snowflake',
  'silence',
  'sound',
  'sky',
  'shape',
  'surf',
  'thunder',
  'violet',
  'water',
  'wildflower',
  'wave',
  'resonance',
  'log',
  'dream',
  'cherry',
  'tree',
  'fog',
  'frost',
  'voice',
  'paper',
  'frog',
  'smoke',
  'star',
];

export function generateInvitePassphrase(): string {
  const adjective = ADJECTIVES[randomInt(ADJECTIVES.length)]!;
  const noun = NOUNS[randomInt(NOUNS.length)]!;
  return `${adjective}-${noun}-${randomInt(10, 100)}`;
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export interface InviteDeps {
  db: AppDatabase;
  masterKey: Buffer;
  config: Config;
}

export interface CreatedInvite {
  url: string;
  /** SVG QR code of `url`, for onboarding phones without typing the link. */
  urlQr: string;
  uriPassphrase: string;
  expiresAt: string;
}

export async function createInvite(
  deps: InviteDeps,
  input: {
    vaultId: string;
    deviceId: string;
    couchUsername: string;
    couchPassword: string;
    ttlMinutes?: number;
  },
): Promise<CreatedInvite> {
  const vault = deps.db
    .prepare(
      'SELECT name, couch_db_name, e2ee_passphrase_enc, settings_json, encrypted FROM vaults WHERE id = ?',
    )
    .get(input.vaultId) as
    | {
        name: string;
        couch_db_name: string;
        e2ee_passphrase_enc: Buffer;
        settings_json: string;
        encrypted: number;
      }
    | undefined;
  const device = deps.db.prepare('SELECT name FROM devices WHERE id = ?').get(input.deviceId) as
    { name: string } | undefined;
  if (!vault || !device) {
    throw new Error('Vault or device not found');
  }

  // Current LiveSync setup persists remote connections as a profile. Keep the
  // payload compact enough for a phone-scannable QR code; the full factory
  // settings object exceeds QR capacity.
  const conf: Record<string, unknown> = {
    ...(JSON.parse(vault.settings_json) as Record<string, unknown>),
    couchDB_URI: deps.config.couchdb.publicUrl,
    couchDB_USER: input.couchUsername,
    couchDB_PASSWORD: input.couchPassword,
    couchDB_DBNAME: vault.couch_db_name,
    isConfigured: true,
  };
  if (vault.encrypted === 1) {
    conf.passphrase = decryptSecret(deps.masterKey, vault.e2ee_passphrase_enc, {
      table: 'vaults',
      column: 'e2ee_passphrase_enc',
      rowId: input.vaultId,
    });
  }
  // Match upstream's CouchDB setup generator: create and select the profile
  // while retaining compatibility fields for established clients. The ID is
  // stable because credentials vary per device but the selected remote does not.
  upsertRemoteConfigurationInPlace(conf as unknown as ObsidianLiveSyncSettings, 'couchdb', {
    id: 'livesync-manager-couchdb',
    name: 'LiveSync Manager CouchDB',
    activate: true,
  });
  const uriPassphrase = generateInvitePassphrase();
  const setupUri = await encryptSetupUri(conf, uriPassphrase);
  const token = randomBytes(32).toString('base64url');
  const id = uuidv7();
  const ttl = Math.min(Math.max(input.ttlMinutes ?? deps.config.inviteTtlMinutes, 1), 1440);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttl * 60_000).toISOString();

  // A device has at most one live invite; stale ones hold credentials and
  // are deleted, not kept around.
  deps.db
    .prepare('DELETE FROM invites WHERE device_id = ? AND used_at IS NULL')
    .run(input.deviceId);
  deps.db
    .prepare(
      `INSERT INTO invites (id, vault_id, device_id, token_hash, uri_passphrase_enc,
                            setup_uri_enc, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      input.vaultId,
      input.deviceId,
      hashToken(token),
      encryptSecret(deps.masterKey, uriPassphrase, {
        table: 'invites',
        column: 'uri_passphrase_enc',
        rowId: id,
      }),
      encryptSecret(deps.masterKey, setupUri, {
        table: 'invites',
        column: 'setup_uri_enc',
        rowId: id,
      }),
      expiresAt,
      now.toISOString(),
    );

  recordEvent(deps.db, {
    level: 'info',
    actor: 'admin',
    message: `Created invite for device ${device.name} of vault ${vault.name}`,
    vaultId: input.vaultId,
    deviceId: input.deviceId,
  });
  const url = `${deps.config.publicBaseUrl.replace(/\/+$/, '')}/invite/${token}`;
  return {
    url,
    urlQr: await QRCode.toString(url, { type: 'svg', margin: 1 }),
    uriPassphrase,
    expiresAt,
  };
}

export interface InvitePage {
  vaultName: string;
  deviceName: string;
  setupUri: string;
  uriPassphrase: string;
  expiresAt: string;
}

interface InviteRow {
  id: string;
  vault_id: string;
  device_id: string;
  uri_passphrase_enc: Buffer;
  setup_uri_enc: Buffer;
  expires_at: string;
  vault_name: string;
  device_name: string;
}

function findValidRow(db: AppDatabase, token: string): InviteRow | undefined {
  // Lookup by SHA-256 of the token: no plaintext at rest, and no
  // content-dependent comparison against attacker input.
  const row = db
    .prepare(
      `SELECT i.id, i.vault_id, i.device_id, i.uri_passphrase_enc, i.setup_uri_enc, i.expires_at,
              v.name AS vault_name, d.name AS device_name
       FROM invites i
       JOIN vaults v ON v.id = i.vault_id
       JOIN devices d ON d.id = i.device_id
       WHERE i.token_hash = ? AND i.used_at IS NULL`,
    )
    .get(hashToken(token)) as InviteRow | undefined;
  if (!row || row.expires_at <= new Date().toISOString()) {
    return undefined;
  }
  return row;
}

export function findInvite(deps: InviteDeps, token: string): InvitePage | undefined {
  const row = findValidRow(deps.db, token);
  if (!row) {
    return undefined;
  }
  return {
    vaultName: row.vault_name,
    deviceName: row.device_name,
    setupUri: decryptSecret(deps.masterKey, row.setup_uri_enc, {
      table: 'invites',
      column: 'setup_uri_enc',
      rowId: row.id,
    }),
    uriPassphrase: decryptSecret(deps.masterKey, row.uri_passphrase_enc, {
      table: 'invites',
      column: 'uri_passphrase_enc',
      rowId: row.id,
    }),
    expiresAt: row.expires_at,
  };
}

export function consumeInvite(deps: InviteDeps, token: string): boolean {
  const row = findValidRow(deps.db, token);
  if (!row) {
    return false;
  }
  const now = new Date().toISOString();
  deps.db.prepare('UPDATE invites SET used_at = ? WHERE id = ?').run(now, row.id);
  // Consuming the invite is the "I've imported it" signal: the device goes
  // active (LIVESYNC_INTEGRATION.md § 4) and gets its first activity mark.
  deps.db
    .prepare(
      `UPDATE devices SET status = 'active', first_connected = COALESCE(first_connected, ?),
       last_seen = ? WHERE id = ? AND status = 'pending'`,
    )
    .run(now, now, row.device_id);
  recordEvent(deps.db, {
    level: 'info',
    actor: 'system',
    message: `Device ${row.device_name} connected to vault ${row.vault_name}`,
    vaultId: row.vault_id,
    deviceId: row.device_id,
  });
  return true;
}
