# SECURITY.md

These decisions are binding for v1. Changing any of them requires updating
this document first.

## Reporting a vulnerability

Please report security issues privately, not as a public issue. Use GitHub's
private reporting: on the repository, go to the **Security** tab and choose
**Report a vulnerability** (this opens a private advisory visible only to the
maintainers). Include what you found, how to reproduce it, and the impact you
see.

This is a single-maintainer project, so expect an acknowledgement within a
few days rather than same-day. Fixes ship as a new tagged release with the
issue credited in the notes unless you ask otherwise. There is no bounty.

## Threat model

Single administrator, self-hosted, one trusted server. In scope:

- Compromise of an invite link in transit or after expiry
- A lost/stolen device that previously synced a vault
- Casual exposure of the app database file (bad backup hygiene)
- Opportunistic network attackers (hence HTTPS-only)

Explicitly out of scope for v1:

- A fully compromised host running this app (it holds the keys; see below)
- Malicious admin
- Multi-tenant isolation (this is not SaaS; see AGENTS.md)

## The two passphrases (never conflate)

| Secret | Purpose | Lifetime | Stored where |
|---|---|---|---|
| **E2EE passphrase** | LiveSync encrypts note content/paths in CouchDB | Life of the vault | App SQLite, encrypted with master key |
| **Setup-URI passphrase** | Encrypts the `obsidian://setuplivesync?settings=` payload only | Life of one invite (minutes) | App SQLite (encrypted) until invite expiry, shown once on the invite page |

Naming convention in code: `e2eePassphrase` vs `uriPassphrase`. UI copy must
call them "vault encryption passphrase" and "invite passphrase".

## Decision: E2EE is optional per vault (default on)

A vault may be created (or adopted) with `encrypted: false`: LiveSync then
syncs note content in plaintext (`encrypt: false`, no path obfuscation).
This is for setups where CouchDB itself is inside the trust boundary and
the passphrase-per-vault overhead is unwanted. The UI labels such vaults
"unencrypted"; encryption cannot be toggled after creation (that requires
a client-side rebuild, like rotation).

## Decision: the app stores E2EE passphrases

We store each vault's E2EE passphrase (encrypted at rest) because minting
future invites requires embedding it in setup URIs. **Consequence, stated
honestly:** the server running this app can decrypt vault content. The E2EE
guarantee degrades from "server never can read notes" to "notes are encrypted
at rest in CouchDB; the control plane is trusted." For a single admin running
both on their own infrastructure, this is the same trust domain, and acceptable.
A future "zero-knowledge mode" (passphrase shown once at vault creation,
never stored, invites require re-entering it) is designed for but not built.

## Master key

- 32-byte key in a file (`MASTER_KEY_FILE`, default `/data/master.key`,
  mode 0600), generated on first boot if absent. Env-var injection supported
  for K8s secret mounting (1Password Connect / External Secrets friendly).
- All secret columns (`*_enc`) use AES-256-GCM with random nonce per value,
  AAD = table + column + row id (prevents ciphertext swapping between rows).
- Losing the master key loses stored passphrases/credentials. The docs and
  first-boot UI must say: back up `/data` (SQLite + key) together, and keep
  the E2EE passphrase independently in a password manager.

## Credentials

- Admin password: argon2id, parameters pinned in config.
- CouchDB admin credentials: provided via env/config, encrypted at rest if
  persisted; never sent to any client.
- Per-device CouchDB users: 32+ chars random passwords; scoped as members of
  exactly one database via `_security`. No device user is ever a server admin.
- Revocation deletes/disables the CouchDB user. Note in UI: a revoked device
  keeps its local vault copy and knows the E2EE passphrase; revocation stops
  future sync, it does not un-share history.

### Lost admin password

There is no email recovery (the app has no mail configuration and one
admin). Recovery is proof of host access instead: run `npm run reset-admin`
inside the container, against the data directory.

```sh
docker compose exec app npm run reset-admin
# or, on Kubernetes:
kubectl exec -n <namespace> deploy/livesync-manager -- npm run reset-admin
```

This clears the stored password hash and every session, returning the
app to its first-boot state; open it and set a new password. Anyone who
can run the script can already read `/data` and the master key, so it asks
for nothing more. It does briefly reopen the unauthenticated first-boot
window, so set the new password promptly and keep the app off the public
internet (it should be anyway). Nothing else in `/data` is touched: vaults,
devices, and the master key are unaffected.

## Invite links

- Token: 256-bit random, URL-safe; stored as SHA-256 hash; constant-time
  compare; single-use; default TTL 15 minutes (configurable, max 24 h).
- The invite page is the only place the setup URI and URI passphrase appear.
  `Cache-Control: no-store`, `Referrer-Policy: no-referrer`, no logging of
  token values.
- Rate-limit and lockout on `/invite/*`.
- The setup URI embeds device-scoped credentials only; leaking one invite
  post-hoc compromises at most one revocable device credential (plus the E2EE
  passphrase, which is why TTL is short and use is single).

## Transport & headers

- HTTPS required; in-app enforcement assumes TLS termination at the proxy but
  sets HSTS, sets `Secure` cookies, and refuses to serve invites over plain
  HTTP (checks `X-Forwarded-Proto`).
- CSP: default-src 'self'; the SPA needs no third-party origins. QR codes are
  generated server-side or with a bundled lib; no external QR services ever.

## Audit log

Every mutation writes an event: who (admin/system), what, which vault/device,
when. Events never contain secret material. Events are append-only from the
app's perspective (no delete endpoint in v1).

## Non-negotiables checklist for code review

- [ ] No secret in logs, events, error messages, or URLs (invite token is the
      sole exception, by design, and is never logged)
- [ ] All `*_enc` writes go through `src/crypto`; no ad-hoc crypto
- [ ] Destructive endpoints implement the confirm-token flow server-side
- [ ] Invite tokens hashed at rest, constant-time compared
- [ ] CouchDB errors surfaced to UI are sanitized (no connection strings)
