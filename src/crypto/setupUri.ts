// The one place octagonal-wheels is touched (CLAUDE.md: never hand-roll
// this crypto; it must stay decrypt-compatible with the LiveSync plugin).
import { decrypt, encrypt } from 'octagonal-wheels/encryption/encryption.js';

const URI_BASE = 'obsidian://setuplivesync?settings=';

export async function encryptSetupUri(
  conf: Record<string, unknown>,
  uriPassphrase: string,
): Promise<string> {
  return URI_BASE + encodeURIComponent(await encrypt(JSON.stringify(conf), uriPassphrase, false));
}

export async function decryptSetupUri(
  uri: string,
  uriPassphrase: string,
): Promise<Record<string, unknown>> {
  if (!uri.startsWith(URI_BASE)) {
    throw new Error('Not a LiveSync setup URI');
  }
  const payload = decodeURIComponent(uri.slice(URI_BASE.length));
  return JSON.parse(await decrypt(payload, uriPassphrase, false)) as Record<string, unknown>;
}
