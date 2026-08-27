// Small shared pieces: cards, badges, confirm dialog, invite reveal.
import { useState, type FormEvent, type ReactNode } from 'react';
import type { DryRun, Invite } from './api.js';

export function Card(props: { title: string; children: ReactNode; actions?: ReactNode }) {
  return (
    <section className="card">
      <header>
        <h2>{props.title}</h2>
        {props.actions && <div className="card-actions">{props.actions}</div>}
      </header>
      {props.children}
    </section>
  );
}

export function Badge(props: { kind: string; children: ReactNode }) {
  return <span className={`badge badge-${props.kind}`}>{props.children}</span>;
}

export function statusBadge(status: string) {
  const kind =
    {
      active: 'ok',
      verified: 'ok',
      ok: 'ok',
      pending: 'warn',
      running: 'warn',
      complete: 'warn',
      degraded: 'warn',
      archived: 'muted',
      unknown: 'muted',
      revoked: 'danger',
      failed: 'danger',
    }[status] ?? 'muted';
  return <Badge kind={kind}>{status}</Badge>;
}

export function ErrorLine(props: { error: string | null }) {
  return props.error ? <p className="error">{props.error}</p> : null;
}

export function timeAgo(iso: string | null): string {
  if (!iso) return 'never';
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.floor(hours / 24)} days ago`;
}

/**
 * Destructive-operation dialog: shows the server's dry-run consequences and
 * requires typing the resource name when the API demands it.
 */
export function ConfirmDialog(props: {
  title: string;
  dryRun: DryRun;
  typedNameLabel?: string;
  acknowledgementLabel?: string;
  busy: boolean;
  error: string | null;
  onConfirm: (confirmToken: string, typedName: string, acknowledged: boolean) => void;
  onCancel: () => void;
}) {
  const [typedName, setTypedName] = useState('');
  const [acknowledged, setAcknowledged] = useState(false);
  function submit(e: FormEvent) {
    e.preventDefault();
    props.onConfirm(props.dryRun.confirmToken, typedName, acknowledged);
  }
  return (
    <div className="overlay">
      <form className="dialog" onSubmit={submit}>
        <h2>{props.title}</h2>
        <ul>
          {props.dryRun.consequences.map((c, i) => (
            <li key={i}>{c}</li>
          ))}
        </ul>
        {props.typedNameLabel && (
          <label>
            Type <strong>{props.typedNameLabel}</strong> to confirm
            <input value={typedName} onChange={(e) => setTypedName(e.target.value)} autoFocus />
          </label>
        )}
        {props.acknowledgementLabel && (
          <label>
            <input
              type="checkbox"
              checked={acknowledged}
              onChange={(e) => setAcknowledged(e.target.checked)}
            />{' '}
            {props.acknowledgementLabel}
          </label>
        )}
        <ErrorLine error={props.error} />
        <div className="dialog-buttons">
          <button type="button" onClick={props.onCancel} disabled={props.busy}>
            Cancel
          </button>
          <button
            type="submit"
            className="danger"
            disabled={props.busy || (Boolean(props.acknowledgementLabel) && !acknowledged)}
          >
            {props.busy ? 'Working...' : props.title}
          </button>
        </div>
      </form>
    </div>
  );
}

/** Shows a freshly minted invite. The passphrase is never retrievable again. */
export function InviteReveal(props: { deviceName: string; invite: Invite; onClose: () => void }) {
  return (
    <div className="overlay">
      <div className="dialog">
        <h2>Invite for {props.deviceName}</h2>
        <p>
          Scan with the new device's camera, or open the link on it. The Obsidian vault on that
          device must be <strong>empty</strong>. Use Self-hosted LiveSync 1.0.13 or newer.
        </p>
        <div className="invite-qr" dangerouslySetInnerHTML={{ __html: props.invite.urlQr }} />
        <p className="reveal">
          <a href={props.invite.url} target="_blank" rel="noreferrer">
            {props.invite.url}
          </a>
        </p>
        <p>Invite passphrase (typed once on the device):</p>
        <p className="reveal passphrase">{props.invite.uriPassphrase}</p>
        <p className="muted">
          Single use, expires {new Date(props.invite.expiresAt).toLocaleString()}. This passphrase
          is not shown again, so reinvite if it is lost.
        </p>
        <div className="dialog-buttons">
          <button onClick={props.onClose}>Done</button>
        </div>
      </div>
    </div>
  );
}

/** Shows the vault E2EE passphrase exactly once, at creation. */
export function PassphraseReveal(props: {
  vaultName: string;
  passphrase: string;
  onClose: () => void;
}) {
  return (
    <div className="overlay">
      <div className="dialog">
        <h2>Vault {props.vaultName} created</h2>
        <p>
          This is the vault encryption passphrase. Store it in your password manager
          <strong> now</strong>. It is never shown again, and without it (or this server's data
          directory) your notes cannot be decrypted.
        </p>
        <p className="reveal passphrase">{props.passphrase}</p>
        <div className="dialog-buttons">
          <button onClick={props.onClose}>I stored it</button>
        </div>
      </div>
    </div>
  );
}
