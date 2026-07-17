import { useCallback, useEffect, useState, type FormEvent } from 'react';
import {
  api,
  ApiError,
  type AdoptableDatabase,
  type ConfigCheckResult,
  type ConfigFixResult,
  type EventEntry,
  type Health,
  type Vault,
  type VaultHealth,
} from '../api.js';
import { Badge, Card, ErrorLine, PassphraseReveal, statusBadge, timeAgo } from '../ui.js';

interface VaultWithHealth extends Vault {
  health?: VaultHealth;
}

// The four questions (AGENTS.md), answered above the fold.
function StatusCards(props: {
  vaults: VaultWithHealth[];
  health: Health | null;
  config: ConfigCheckResult | null;
}) {
  const active = props.vaults.filter((v) => v.status === 'active');
  const warnings = active.flatMap((v) => v.health?.warnings ?? []);
  const verifiedTimes = active
    .map((v) => v.health?.backup.lastVerifiedAt)
    .filter((t): t is string => t != null);
  const devices = active
    .flatMap((v) => v.health?.devices ?? [])
    .filter((d) => d.status !== 'revoked');

  const notesSafe =
    active.length === 0
      ? ['No vaults yet', 'muted']
      : verifiedTimes.length === active.length
        ? [
            `Yes: every vault has a verified backup (latest ${timeAgo(verifiedTimes.sort().at(-1)!)})`,
            'ok',
          ]
        : ['Not fully: some vaults lack a verified backup', 'warn'];
  const devicesSynced =
    devices.length === 0
      ? ['No devices yet', 'muted']
      : [
          `${devices.length} device(s); oldest activity ${timeAgo(devices.map((d) => d.lastSeen).sort()[0] ?? null)} (approximate)`,
          'ok',
        ];
  const backupsHealthy =
    warnings.length === 0
      ? active.length > 0
        ? ['Yes, no warnings', 'ok']
        : ['No vaults yet', 'muted']
      : [`${warnings.length} warning(s); see vaults below`, 'warn'];
  const safeToAdd = !props.config
    ? ['Checking...', 'muted']
    : props.config.ok
      ? ['Yes, CouchDB is configured for LiveSync', 'ok']
      : ['Fix the server configuration first', 'danger'];

  const cards: [string, (string | undefined)[]][] = [
    ['Are my notes safe?', notesSafe],
    ['Are my devices synced?', devicesSynced],
    ['Are backups healthy?', backupsHealthy],
    ['Can I add a device?', safeToAdd],
  ];
  return (
    <div className="status-grid">
      {cards.map(([question, [answer, kind]]) => (
        <div key={question} className={`status-card status-${kind}`}>
          <h3>{question}</h3>
          <p>{answer}</p>
        </div>
      ))}
    </div>
  );
}

function ServerPanel(props: {
  health: Health | null;
  config: ConfigCheckResult | null;
  onRefresh: () => void;
}) {
  const [fixResult, setFixResult] = useState<ConfigFixResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function fix() {
    setBusy(true);
    setError(null);
    try {
      setFixResult(await api.post<ConfigFixResult>('/server/config/fix'));
      props.onRefresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const failing = props.config?.checks.filter((c) => !c.ok) ?? [];
  return (
    <Card
      title="CouchDB server"
      actions={
        props.config && !props.config.ok ? (
          <button onClick={() => void fix()} disabled={busy}>
            {busy ? 'Fixing...' : 'Apply recommended configuration'}
          </button>
        ) : undefined
      }
    >
      {props.health && (
        <p>
          {statusBadge(props.health.status)}{' '}
          {props.health.couchdb.reachable
            ? `CouchDB ${props.health.couchdb.version} (${props.health.couchdb.latencyMs} ms)`
            : `Unreachable: ${props.health.couchdb.error ?? 'unknown error'}`}
          {props.health.checkedAt && (
            <span className="muted"> (checked {timeAgo(props.health.checkedAt)})</span>
          )}
        </p>
      )}
      {props.config &&
        (props.config.ok ? (
          <p>
            <Badge kind="ok">configured</Badge> All LiveSync-required settings are in place on node{' '}
            {props.config.node}.
          </p>
        ) : (
          <>
            <p>
              <Badge kind="danger">action needed</Badge> {failing.length} setting(s) differ from
              what LiveSync needs:
            </p>
            <ul>
              {failing.map((c) => (
                <li key={`${c.section}/${c.key}`}>
                  <code>
                    {c.section}/{c.key}
                  </code>{' '}
                  is {c.actual === undefined ? 'unset' : <code>{c.actual}</code>}, expected{' '}
                  <code>{c.expected}</code>
                </li>
              ))}
            </ul>
          </>
        ))}
      {fixResult && <p className="muted">{fixResult.note}</p>}
      <ErrorLine error={error} />
    </Card>
  );
}

function CreateVault(props: { onCreated: () => void }) {
  const [name, setName] = useState('');
  const [encrypted, setEncrypted] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reveal, setReveal] = useState<{ name: string; passphrase: string } | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const vault = await api.post<Vault & { e2eePassphrase?: string }>('/vaults', {
        name,
        encrypted,
      });
      setName('');
      if (vault.e2eePassphrase) {
        setReveal({ name: vault.name, passphrase: vault.e2eePassphrase });
      } else {
        props.onCreated();
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <form className="inline-form" onSubmit={submit}>
        <input
          placeholder="New vault name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
        />
        <label className="inline-check" title="Recommended. Unencrypted vaults sync in plaintext.">
          <input
            type="checkbox"
            checked={encrypted}
            onChange={(e) => setEncrypted(e.target.checked)}
          />
          encrypt
        </label>
        <button type="submit" disabled={busy}>
          {busy ? 'Creating...' : 'Create vault'}
        </button>
      </form>
      <ErrorLine error={error} />
      {reveal && (
        <PassphraseReveal
          vaultName={reveal.name}
          passphrase={reveal.passphrase}
          onClose={() => {
            setReveal(null);
            props.onCreated();
          }}
        />
      )}
    </>
  );
}

function AdoptVault(props: { candidates: AdoptableDatabase[]; onCreated: () => void }) {
  const { candidates } = props;
  const [couchDbName, setCouchDbName] = useState('');
  const [name, setName] = useState('');
  const [encrypted, setEncrypted] = useState(true);
  const [passphrase, setPassphrase] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (candidates.length === 0) {
    return null;
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post('/vaults/connect', {
        name,
        couchDbName,
        encrypted,
        ...(encrypted ? { e2eePassphrase: passphrase } : {}),
      });
      props.onCreated();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="Connect existing database">
      <p className="muted">
        Unmanaged databases on this CouchDB. Adopting one changes nothing on the server: devices
        using their current credentials keep syncing until you migrate them.
      </p>
      <form className="inline-form" onSubmit={submit}>
        <select value={couchDbName} onChange={(e) => setCouchDbName(e.target.value)} required>
          <option value="">database...</option>
          {candidates.map((c) => (
            <option key={c.name} value={c.name}>
              {c.name} ({c.docCount.toLocaleString()} docs)
            </option>
          ))}
        </select>
        <input
          placeholder="Vault name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
        />
        <label className="inline-check">
          <input
            type="checkbox"
            checked={encrypted}
            onChange={(e) => setEncrypted(e.target.checked)}
          />
          encrypted
        </label>
        {encrypted && (
          <input
            type="password"
            placeholder="Its E2EE passphrase"
            value={passphrase}
            onChange={(e) => setPassphrase(e.target.value)}
            required
          />
        )}
        <button type="submit" disabled={busy}>
          {busy ? 'Adopting...' : 'Adopt'}
        </button>
      </form>
      <ErrorLine error={error} />
    </Card>
  );
}

export function EventsFeed(props: { events: EventEntry[] }) {
  if (props.events.length === 0) {
    return <p className="muted">Nothing yet.</p>;
  }
  return (
    <table>
      <tbody>
        {props.events.map((e) => (
          <tr key={e.id}>
            <td className="muted nowrap">{timeAgo(e.ts)}</td>
            <td>
              {statusBadge(e.level === 'info' ? 'ok' : e.level === 'warn' ? 'pending' : 'failed')}
            </td>
            <td>{e.message}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function ChangePasswordButton() {
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function close() {
    setOpen(false);
    setCurrent('');
    setNext('');
    setConfirm('');
    setDone(false);
    setError(null);
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (next !== confirm) {
      setError('The new passwords do not match.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.post('/auth/password', { currentPassword: current, newPassword: next });
      setDone(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button className="link" onClick={() => setOpen(true)}>
        Change password
      </button>
      {open && (
        <div className="overlay">
          <form className="dialog" onSubmit={submit}>
            <h2>Change admin password</h2>
            {done ? (
              <>
                <p>Password changed. Any other signed-in browsers were logged out.</p>
                <div className="dialog-buttons">
                  <button type="button" onClick={close}>
                    Done
                  </button>
                </div>
              </>
            ) : (
              <>
                <label>
                  Current password
                  <input
                    type="password"
                    value={current}
                    onChange={(e) => setCurrent(e.target.value)}
                    autoFocus
                    required
                  />
                </label>
                <label>
                  New password (at least 12 characters)
                  <input
                    type="password"
                    value={next}
                    onChange={(e) => setNext(e.target.value)}
                    required
                  />
                </label>
                <label>
                  Repeat new password
                  <input
                    type="password"
                    value={confirm}
                    onChange={(e) => setConfirm(e.target.value)}
                    required
                  />
                </label>
                <ErrorLine error={error} />
                <div className="dialog-buttons">
                  <button type="button" onClick={close} disabled={busy}>
                    Cancel
                  </button>
                  <button type="submit" disabled={busy}>
                    {busy ? 'Working...' : 'Change password'}
                  </button>
                </div>
              </>
            )}
          </form>
        </div>
      )}
    </>
  );
}

export function Dashboard(props: { onLogout: () => void }) {
  const [vaults, setVaults] = useState<VaultWithHealth[]>([]);
  const [health, setHealth] = useState<Health | null>(null);
  const [config, setConfig] = useState<ConfigCheckResult | null>(null);
  const [events, setEvents] = useState<EventEntry[]>([]);
  const [adoptable, setAdoptable] = useState<AdoptableDatabase[]>([]);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    void (async () => {
      try {
        const [vaultList, healthRes, configRes, eventsRes, adoptableRes] = await Promise.all([
          api.get<Vault[]>('/vaults?archived=1'),
          api.get<Health>('/health'),
          api.get<ConfigCheckResult>('/server/config'),
          api.get<EventEntry[]>('/events?limit=15'),
          api.get<AdoptableDatabase[]>('/vaults/adoptable').catch(() => []),
        ]);
        const withHealth = await Promise.all(
          vaultList.map(async (v) => ({
            ...v,
            health:
              v.status === 'active'
                ? await api.get<VaultHealth>(`/vaults/${v.id}/health`).catch(() => undefined)
                : undefined,
          })),
        );
        setVaults(withHealth);
        setHealth(healthRes);
        setConfig(configRes);
        setEvents(eventsRes);
        setAdoptable(adoptableRes);
        setError(null);
      } catch (err) {
        setError(err instanceof ApiError ? err.message : String(err));
      }
    })();
  }, []);

  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, 60_000);
    return () => clearInterval(timer);
  }, [refresh]);

  return (
    <main>
      <nav>
        <h1>LiveSync Manager</h1>
        <span className="nav-actions">
          <ChangePasswordButton />
          <button className="link" onClick={props.onLogout}>
            Sign out
          </button>
        </span>
      </nav>
      <ErrorLine error={error} />
      {adoptable.length > 0 && (
        <div className="warnings">
          <p>
            Found {adoptable.length} database(s) on CouchDB that this app does not manage:{' '}
            {adoptable.map((d) => d.name).join(', ')}. Adopt them below so their backups, devices,
            and health are looked after. Adoption changes nothing on the server.
          </p>
        </div>
      )}
      <StatusCards vaults={vaults} health={health} config={config} />
      <ServerPanel health={health} config={config} onRefresh={refresh} />
      <Card title="Vaults" actions={<CreateVault onCreated={refresh} />}>
        {vaults.length === 0 ? (
          <p className="muted">No vaults yet. Create one above, then add your devices to it.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Status</th>
                <th>Devices</th>
                <th>Last verified backup</th>
                <th>Warnings</th>
              </tr>
            </thead>
            <tbody>
              {vaults.map((v) => (
                <tr key={v.id}>
                  <td>
                    <a href={`#/vault/${v.id}`}>{v.name}</a>
                  </td>
                  <td>{statusBadge(v.status)}</td>
                  <td>{v.health?.devices.length ?? '-'}</td>
                  <td>{timeAgo(v.health?.backup.lastVerifiedAt ?? null)}</td>
                  <td>
                    {v.health && v.health.warnings.length > 0 ? (
                      <Badge kind="warn">{v.health.warnings.length}</Badge>
                    ) : (
                      <span className="muted">none</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      <AdoptVault candidates={adoptable} onCreated={refresh} />
      <Card title="Recent activity">
        <EventsFeed events={events} />
      </Card>
    </main>
  );
}
