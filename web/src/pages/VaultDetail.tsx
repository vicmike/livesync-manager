import { useCallback, useEffect, useState, type FormEvent } from 'react';
import {
  api,
  ApiError,
  type Backup,
  type Device,
  type DryRun,
  type EventEntry,
  type Invite,
  type RestoreResult,
  type SwapResult,
  type VaultDetail as VaultDetailData,
  type VaultHealth,
} from '../api.js';
import {
  Badge,
  Card,
  ConfirmDialog,
  ErrorLine,
  InviteReveal,
  statusBadge,
  timeAgo,
} from '../ui.js';
import { EventsFeed } from './Dashboard.js';

function bytes(n: number | null): string {
  if (n === null) return '-';
  return n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.ceil(n / 1024)} kB`;
}

function Devices(props: {
  vaultId: string;
  devices: Device[];
  health: VaultHealth | null;
  onChange: () => void;
}) {
  const [name, setName] = useState('');
  const [platform, setPlatform] = useState('desktop');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reveal, setReveal] = useState<{ deviceName: string; invite: Invite } | null>(null);
  const [revoking, setRevoking] = useState<{ device: Device; dryRun: DryRun } | null>(null);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  function add(e: FormEvent) {
    e.preventDefault();
    void run(async () => {
      const result = await api.post<{ device: Device; invite: Invite }>(
        `/vaults/${props.vaultId}/devices`,
        { name, platform },
      );
      setReveal({ deviceName: result.device.name, invite: result.invite });
      setName('');
      props.onChange();
    });
  }

  function reinvite(device: Device) {
    void run(async () => {
      const result = await api.post<{ invite: Invite }>(`/devices/${device.id}/reinvite`);
      setReveal({ deviceName: device.name, invite: result.invite });
      props.onChange();
    });
  }

  function markConnected(device: Device) {
    void run(async () => {
      await api.post(`/devices/${device.id}/connected`);
      props.onChange();
    });
  }

  function startRevoke(device: Device) {
    void run(async () => {
      const dryRun = await api.post<DryRun>(`/devices/${device.id}/revoke?dryRun=1`);
      setRevoking({ device, dryRun });
    });
  }

  return (
    <Card
      title="Devices"
      actions={
        <form className="inline-form" onSubmit={add}>
          <input
            placeholder="New device name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
          />
          <select value={platform} onChange={(e) => setPlatform(e.target.value)}>
            <option value="desktop">desktop</option>
            <option value="ios">ios</option>
            <option value="android">android</option>
            <option value="unknown">other</option>
          </select>
          <button type="submit" disabled={busy}>
            Add device
          </button>
        </form>
      }
    >
      {props.devices.length === 0 ? (
        <p className="muted">
          No devices yet. Add one to get a single-use invite link to open on that device.
        </p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Platform</th>
              <th>Status</th>
              <th>Access</th>
              <th>Connection confirmed</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {props.devices.map((d) => (
              <tr key={d.id}>
                <td>{d.name}</td>
                <td className="muted">{d.platform ?? '-'}</td>
                <td>{statusBadge(d.status)}</td>
                <td>
                  {d.status === 'revoked'
                    ? '-'
                    : statusBadge(
                        props.health?.devices.find((healthDevice) => healthDevice.id === d.id)
                          ?.access ?? 'unknown',
                      )}
                </td>
                <td className="muted">
                  {d.status === 'revoked'
                    ? `revoked ${timeAgo(d.revokedAt)}`
                    : d.firstConnected
                      ? timeAgo(d.firstConnected)
                      : 'not confirmed'}
                </td>
                <td className="row-actions">
                  {d.status !== 'revoked' && (
                    <>
                      {d.status === 'pending' && (
                        <button
                          className="link"
                          disabled={busy}
                          title="It's syncing; the invite page's confirm button was just skipped"
                          onClick={() => markConnected(d)}
                        >
                          mark connected
                        </button>
                      )}
                      <button className="link" disabled={busy} onClick={() => reinvite(d)}>
                        reinvite
                      </button>
                      <button
                        className="link danger"
                        disabled={busy}
                        onClick={() => startRevoke(d)}
                      >
                        revoke
                      </button>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="muted">
        The manager can verify whether a device account is configured, but CouchDB does not expose a
        reliable live per-device sync signal. “Connection confirmed” records onboarding, not recent
        sync activity.
      </p>
      <ErrorLine error={error} />
      {reveal && (
        <InviteReveal
          deviceName={reveal.deviceName}
          invite={reveal.invite}
          onClose={() => setReveal(null)}
        />
      )}
      {revoking && (
        <ConfirmDialog
          title={`Revoke ${revoking.device.name}`}
          dryRun={revoking.dryRun}
          busy={busy}
          error={error}
          onCancel={() => setRevoking(null)}
          onConfirm={(confirmToken) =>
            void run(async () => {
              await api.post(`/devices/${revoking.device.id}/revoke`, { confirmToken });
              setRevoking(null);
              props.onChange();
            })
          }
        />
      )}
    </Card>
  );
}

function Backups(props: { vaultId: string; backups: Backup[]; onChange: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<{ backup: Backup; dryRun: DryRun } | null>(null);
  const [swapping, setSwapping] = useState<{ backup: Backup; dryRun: DryRun } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const hasRunning = props.backups.some((b) => b.status === 'running');
  useEffect(() => {
    if (!hasRunning) return;
    const timer = setInterval(props.onChange, 2000);
    return () => clearInterval(timer);
  }, [hasRunning, props.onChange]);

  return (
    <Card
      title="Backups"
      actions={
        <button
          disabled={busy || hasRunning}
          onClick={() =>
            void run(async () => {
              await api.post(`/vaults/${props.vaultId}/backups`);
              props.onChange();
            })
          }
        >
          Back up now
        </button>
      }
    >
      {props.backups.length === 0 ? (
        <p className="muted">
          No backups yet. The daily scheduler will take one, or trigger one now.
        </p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Started</th>
              <th>Kind</th>
              <th>Status</th>
              <th>Docs</th>
              <th>Size</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {props.backups.map((b) => (
              <tr key={b.id}>
                <td className="muted">{new Date(b.startedAt).toLocaleString()}</td>
                <td className="muted">{b.kind}</td>
                <td>{statusBadge(b.status)}</td>
                <td>{b.docCount ?? '-'}</td>
                <td>{bytes(b.sizeBytes)}</td>
                <td className="row-actions">
                  {(b.status === 'complete' || b.status === 'verified') && (
                    <>
                      <button
                        className="link"
                        disabled={busy}
                        onClick={() =>
                          void run(async () => {
                            const result = await api.post<RestoreResult>(
                              `/backups/${b.id}/restore`,
                            );
                            setNotice(
                              `Restored to ${result.restoredDbName} (${result.docCount} docs), ` +
                                'without touching the live vault. Inspect it, or adopt it from the ' +
                                'dashboard as its own vault.',
                            );
                          })
                        }
                      >
                        restore
                      </button>
                      <button
                        className="link danger"
                        disabled={busy}
                        onClick={() =>
                          void run(async () => {
                            const dryRun = await api.post<DryRun>(
                              `/backups/${b.id}/restore/swap?dryRun=1`,
                            );
                            setSwapping({ backup: b, dryRun });
                          })
                        }
                      >
                        restore &amp; swap
                      </button>
                      <button
                        className="link"
                        disabled={busy}
                        onClick={() =>
                          void run(async () => {
                            await api.post(`/backups/${b.id}/verify`);
                            props.onChange();
                          })
                        }
                      >
                        verify
                      </button>
                      <button
                        className="link danger"
                        disabled={busy}
                        onClick={() =>
                          void run(async () => {
                            const dryRun = await api.delete<DryRun>(`/backups/${b.id}?dryRun=1`);
                            setDeleting({ backup: b, dryRun });
                          })
                        }
                      >
                        delete
                      </button>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <ErrorLine error={error} />
      {notice && <p className="muted">{notice}</p>}
      {swapping && (
        <ConfirmDialog
          title={`Replace live vault with this snapshot`}
          dryRun={swapping.dryRun}
          busy={busy}
          error={error}
          onCancel={() => setSwapping(null)}
          onConfirm={(confirmToken) =>
            void run(async () => {
              const result = await api.post<SwapResult>(
                `/backups/${swapping.backup.id}/restore/swap`,
                { confirmToken },
              );
              setSwapping(null);
              setNotice(
                `Vault restored (${result.docCount} docs). Pre-swap snapshot kept as ` +
                  `${result.preSwapBackup}. Every device must now fetch the vault from the ` +
                  'server again (in the LiveSync plugin: fetch from the remote database).',
              );
              props.onChange();
            })
          }
        />
      )}
      {deleting && (
        <ConfirmDialog
          title="Delete backup"
          dryRun={deleting.dryRun}
          busy={busy}
          error={error}
          onCancel={() => setDeleting(null)}
          onConfirm={(confirmToken) =>
            void run(async () => {
              await api.delete(`/backups/${deleting.backup.id}`, { confirmToken });
              setDeleting(null);
              props.onChange();
            })
          }
        />
      )}
    </Card>
  );
}

function DangerZone(props: { vault: VaultDetailData; onChange: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<DryRun | null>(null);
  const [name, setName] = useState(props.vault.name);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const archived = props.vault.status === 'archived';
  return (
    <Card title="Manage">
      <form
        className="inline-form"
        onSubmit={(e) => {
          e.preventDefault();
          void run(async () => {
            await api.patch(`/vaults/${props.vault.id}`, { name });
            props.onChange();
          });
        }}
      >
        <input value={name} onChange={(e) => setName(e.target.value)} required />
        <button type="submit" disabled={busy || name === props.vault.name}>
          Rename
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() =>
            void run(async () => {
              await api.patch(`/vaults/${props.vault.id}`, { archived: !archived });
              props.onChange();
            })
          }
        >
          {archived ? 'Unarchive' : 'Archive'}
        </button>
        <button
          type="button"
          className="danger"
          disabled={busy}
          onClick={() =>
            void run(async () => {
              setDeleting(await api.delete<DryRun>(`/vaults/${props.vault.id}?dryRun=1`));
            })
          }
        >
          Delete vault
        </button>
      </form>
      <ErrorLine error={error} />
      {deleting && (
        <ConfirmDialog
          title={`Delete vault ${props.vault.name}`}
          dryRun={deleting}
          typedNameLabel={props.vault.name}
          busy={busy}
          error={error}
          onCancel={() => setDeleting(null)}
          onConfirm={(confirmToken, typedName) =>
            void run(async () => {
              await api.delete(`/vaults/${props.vault.id}`, { confirmToken, typedName });
              location.hash = '#/';
            })
          }
        />
      )}
    </Card>
  );
}

function LockButton(props: { vault: VaultDetailData; onChange: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function toggle() {
    setBusy(true);
    setError(null);
    try {
      await api.post(`/vaults/${props.vault.id}/${props.vault.locked ? 'unlock' : 'lock'}`);
      props.onChange();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <button
        className={props.vault.locked ? '' : 'danger'}
        disabled={busy}
        title="The emergency brake: locking removes every device's access until unlocked."
        onClick={() => void toggle()}
      >
        {busy ? 'Working...' : props.vault.locked ? 'Unlock vault' : 'Lock vault'}
      </button>
      <ErrorLine error={error} />
    </>
  );
}

function LegacyMembers(props: { vault: VaultDetailData; onChange: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<{ name: string; dryRun: DryRun } | null>(null);

  async function startRemove(name: string) {
    setBusy(true);
    setError(null);
    try {
      const dryRun = await api.post<DryRun>(`/vaults/${props.vault.id}/members/remove?dryRun=1`, {
        name,
      });
      setRemoving({ name, dryRun });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="Legacy credentials">
      <p className="muted">
        These _security members are not managed by this app, typically the shared user from before
        adoption. Migrate each physical device by adding it under Devices (it gets its own
        credentials via an invite), then remove the shared member here. Note: locking and unlocking
        the vault also removes legacy members.
      </p>
      <table>
        <tbody>
          {props.vault.legacyMembers.map((name) => (
            <tr key={name}>
              <td>
                <code>{name}</code>
              </td>
              <td className="row-actions">
                <button
                  className="link danger"
                  disabled={busy}
                  onClick={() => void startRemove(name)}
                >
                  remove
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <ErrorLine error={error} />
      {removing && (
        <ConfirmDialog
          title={`Remove ${removing.name}`}
          dryRun={removing.dryRun}
          busy={busy}
          error={error}
          onCancel={() => setRemoving(null)}
          onConfirm={(confirmToken) =>
            void (async () => {
              setBusy(true);
              try {
                await api.post(`/vaults/${props.vault.id}/members/remove`, {
                  name: removing.name,
                  confirmToken,
                });
                setRemoving(null);
                props.onChange();
              } catch (err) {
                setError(err instanceof ApiError ? err.message : String(err));
              } finally {
                setBusy(false);
              }
            })()
          }
        />
      )}
    </Card>
  );
}

export function VaultDetailPage(props: { vaultId: string }) {
  const [vault, setVault] = useState<VaultDetailData | null>(null);
  const [health, setHealth] = useState<VaultHealth | null>(null);
  const [devices, setDevices] = useState<Device[]>([]);
  const [backups, setBackups] = useState<Backup[]>([]);
  const [events, setEvents] = useState<EventEntry[]>([]);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    void (async () => {
      try {
        const [vaultRes, healthRes, deviceRes, backupRes, eventRes] = await Promise.all([
          api.get<VaultDetailData>(`/vaults/${props.vaultId}`),
          api.get<VaultHealth>(`/vaults/${props.vaultId}/health`),
          api.get<Device[]>(`/vaults/${props.vaultId}/devices`),
          api.get<Backup[]>(`/vaults/${props.vaultId}/backups`),
          api.get<EventEntry[]>(`/events?vaultId=${props.vaultId}&limit=15`),
        ]);
        setVault(vaultRes);
        setHealth(healthRes);
        setDevices(deviceRes);
        setBackups(backupRes);
        setEvents(eventRes);
        setError(null);
      } catch (err) {
        setError(err instanceof ApiError ? err.message : String(err));
      }
    })();
  }, [props.vaultId]);

  useEffect(refresh, [refresh]);

  if (!vault) {
    return (
      <main>
        <nav>
          <a href="#/">← Dashboard</a>
        </nav>
        <ErrorLine error={error} />
      </main>
    );
  }

  return (
    <main>
      <nav>
        <a href="#/">← Dashboard</a>
        <h1>
          {vault.name} {statusBadge(vault.status)}
          {vault.locked && <Badge kind="danger">locked</Badge>}{' '}
          {!vault.encrypted && <Badge kind="warn">unencrypted</Badge>}
        </h1>
        <LockButton vault={vault} onChange={refresh} />
      </nav>
      <ErrorLine error={error} />
      {health && health.warnings.length > 0 && (
        <div className="warnings">
          {health.warnings.map((w, i) => (
            <p key={i}>{w}</p>
          ))}
        </div>
      )}
      <Card title="Vault">
        <p>
          Database <code>{vault.couchDbName}</code>
          {'docCount' in vault.couch ? (
            <>
              {' '}
              : {vault.couch.docCount.toLocaleString()} docs, {bytes(vault.couch.sizeBytes)}
            </>
          ) : (
            <>
              {' '}
              : <span className="error">{vault.couch.error}</span>
            </>
          )}
        </p>
        <p className="muted">
          Created {timeAgo(vault.createdAt)}. Last verified backup:{' '}
          {timeAgo(health?.backup.lastVerifiedAt ?? null)}.
        </p>
      </Card>
      <Devices vaultId={vault.id} devices={devices} health={health} onChange={refresh} />
      {vault.legacyMembers.length > 0 && <LegacyMembers vault={vault} onChange={refresh} />}
      <Backups vaultId={vault.id} backups={backups} onChange={refresh} />
      <DangerZone vault={vault} onChange={refresh} />
      <Card title="Activity">
        <EventsFeed events={events} />
      </Card>
    </main>
  );
}
