import QRCode from 'qrcode';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { consumeInvite, findInvite, type InvitePage } from '../services/invites.js';
import { FixedWindowLimiter } from '../services/rateLimit.js';

function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

const PAGE_STYLE = `
  body { font-family: system-ui, sans-serif; max-width: 40rem; margin: 2rem auto; padding: 0 1rem; line-height: 1.5; }
  .warning { border: 2px solid #b91c1c; border-radius: 8px; padding: 1rem; margin: 1.5rem 0; }
  .warning strong { color: #b91c1c; }
  .passphrase { font-size: 1.6rem; font-family: ui-monospace, monospace; border: 1px solid #888; border-radius: 8px; padding: 0.75rem 1rem; text-align: center; margin: 1rem 0; user-select: all; }
  .qr { max-width: 16rem; margin: 1rem auto; display: block; }
  .button { display: inline-block; padding: 0.6rem 1.2rem; border-radius: 8px; border: 1px solid #555; background: #f0f0f0; color: #111; text-decoration: none; font-size: 1rem; cursor: pointer; }
  ol li, ul li { margin: 0.4rem 0; }
  footer { margin-top: 2rem; font-size: 0.85rem; color: #666; }
`;

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)}</title>
<style>${PAGE_STYLE}</style>
</head>
<body>
${body}
</body>
</html>`;
}

function renderInvitePage(invite: InvitePage, qrSvg: string, consumePath: string): string {
  const expires = new Date(invite.expiresAt).toUTCString();
  return page(
    `Add device ${invite.deviceName}`,
    `<h1>Connect ${escapeHtml(invite.deviceName)} to vault ${escapeHtml(invite.vaultName)}</h1>
<div class="warning">
<strong>Before you continue:</strong> the Obsidian vault on this device must be
<strong>empty</strong> (a brand-new vault). If it already contains notes, LiveSync will
<strong>merge</strong> them with the vault you are joining. This is very hard to undo.
</div>
<p>Use Self-hosted LiveSync version ${escapeHtml(invite.minimumPluginVersion)} or newer
(older releases have a known synchronisation-scope security issue).${
      invite.idDerivation
        ? ' This vault also uses an independent ID key, which plugin versions before 1.0.33 cannot apply.'
        : ''
    } Update the plugin on this device first if needed.</p>
<ol>
<li>On the new device, create an empty vault in Obsidian and install the
<em>Self-hosted LiveSync</em> community plugin.</li>
<li>Open this page on that device and tap <strong>Set up this device</strong>
below, or scan the QR code with it and open the copied link.</li>
<li>In the <em>Enter Setup URI</em> dialog the link fills in the Setup URI; type
the invite passphrase shown below and choose <strong>Test Settings and
Continue</strong>.</li>
<li>At <em>Mostly Complete: Decision Required</em>, choose
<strong>🔗 Join this device</strong>. (<em>Initialise or overwrite the remote</em>
is only for the very first device of a brand-new vault: it replaces everything
on the server. <em>Apply settings only</em> is for a device that already holds
this vault's data.)</li>
<li>At <em>Setup Complete: Preparing to Fetch Synchronisation Data</em>, choose
<strong>Restart and Fetch Data</strong> and let Obsidian restart.</li>
<li>After the restart, at <em>Data retrieval scheduled</em>, choose
<strong>Overwrite all with remote files</strong>, then
<strong>Keep local files even if not on remote</strong>. (For an empty vault
either second choice is fine.)</li>
<li>Acknowledge <em>All optional features are disabled</em> if it appears, then
let the vault finish downloading. Hidden-file sync and other optional features
can be turned on later in the plugin's settings.</li>
</ol>
<p>If the link does not open the plugin: tap the <em>Welcome to Self-hosted
LiveSync</em> notice in Obsidian, choose <em>I am adding a device to an existing
synchronisation setup</em>, then <em>Use a Setup URI (Recommended)</em>, and
paste the link from the QR code. That path skips the <em>Decision Required</em>
step and goes straight to <em>Restart and Fetch Data</em>.</p>
<p>The device account can sync this vault, but it cannot inspect or change
server-wide CouchDB settings (the plugin's server check may report that as
forbidden; it is expected). Use this manager's server health check for that.</p>
<p style="text-align:center"><a class="button" href="${invite.setupUri}">Set up this device</a></p>
${qrSvg.replace('<svg', '<svg class="qr"')}
<p>Invite passphrase (needed once, on the device):</p>
<div class="passphrase">${escapeHtml(invite.uriPassphrase)}</div>
<form method="post" action="${consumePath}">
<p><button class="button" type="submit">I've imported it, close this invite</button></p>
</form>
<footer>This link is single-use and expires ${expires}. If it has expired, ask for a new invite.</footer>`,
  );
}

// Identical page for unknown, expired, and used tokens: the response must
// not reveal which (SECURITY.md § Invite links).
function renderGone(): string {
  return page(
    'Invite not available',
    `<h1>This invite is not available</h1>
<p>The link is invalid, has expired, or was already used. Ask the person managing
your sync server for a new invite.</p>`,
  );
}

function setInviteHeaders(reply: FastifyReply): void {
  void reply
    .header('cache-control', 'no-store')
    .header('referrer-policy', 'no-referrer')
    .header(
      'content-security-policy',
      "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'",
    )
    .type('text/html; charset=utf-8');
}

/**
 * Public, unauthenticated invite pages, served at the root (not /api/v1) so
 * invite URLs stay short. Never served over plain HTTP except to localhost.
 */
export function inviteRoutes(server: FastifyInstance): void {
  const limiter = new FixedWindowLimiter(30, 5 * 60_000);

  function guard(request: FastifyRequest, reply: FastifyReply): boolean {
    if (!limiter.hit(request.ip)) {
      setInviteHeaders(reply);
      void reply.code(429).send(page('Slow down', '<h1>Too many requests</h1>'));
      return false;
    }
    const local = request.hostname === 'localhost' || request.hostname === '127.0.0.1';
    if (request.protocol !== 'https' && !local) {
      setInviteHeaders(reply);
      void reply
        .code(403)
        .send(
          page(
            'HTTPS required',
            '<h1>HTTPS required</h1><p>Invite links carry credentials and are only served ' +
              'over HTTPS. If TLS terminates at a proxy, make sure it forwards ' +
              'X-Forwarded-Proto and TRUST_PROXY is enabled.</p>',
          ),
        );
      return false;
    }
    return true;
  }

  server.get('/invite/:token', async (request, reply) => {
    if (!guard(request, reply)) return;
    const { token } = request.params as { token: string };
    const invite = findInvite(server, token);
    setInviteHeaders(reply);
    if (!invite) {
      return reply.code(404).send(renderGone());
    }
    const qrSvg = await QRCode.toString(invite.setupUri, { type: 'svg', margin: 1 });
    return reply.send(
      renderInvitePage(invite, qrSvg, `/invite/${encodeURIComponent(token)}/consume`),
    );
  });

  server.post('/invite/:token/consume', async (request, reply) => {
    if (!guard(request, reply)) return;
    const { token } = request.params as { token: string };
    const consumed = consumeInvite(server, token);
    const wantsHtml = (request.headers.accept ?? '').includes('text/html');
    if (!wantsHtml) {
      return consumed
        ? { ok: true }
        : reply.code(404).send({ error: 'Invite is invalid, expired, or already used.' });
    }
    setInviteHeaders(reply);
    return reply
      .code(consumed ? 200 : 404)
      .send(
        consumed
          ? page(
              'Invite closed',
              '<h1>All set</h1><p>This invite is now closed. Your device should be syncing.</p>',
            )
          : renderGone(),
      );
  });
}
