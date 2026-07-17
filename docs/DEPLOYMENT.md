# DEPLOYMENT.md

How the app runs in production. The runtime contract below is binding;
every change must keep plain `docker run` working.

## Runtime contract

- One container, one process. The API serves the SPA; no sidecars, no cron,
  no external queue (the scheduler is in-process; see ARCHITECTURE.md).
- Listens on `0.0.0.0` (and `::` where available) on `PORT`, default 8080.
  Bind explicitly: an IPv6-only bind breaks IPv4 health probes, a
  localhost-only bind breaks containers.
- `GET /api/v1/health` is unauthenticated and cheap; it returns the cached
  result of the most recent poll and never calls CouchDB synchronously. It is
  the liveness/readiness probe target.
- One persistent volume: `/data`, holding the SQLite database and (by
  default) the master key. This is the only state; everything else is
  rebuildable. Back it up as a unit (SECURITY.md § Master key).
- Runs as a non-root user; the image must not require root at runtime.
- TLS terminates at a reverse proxy or ingress in front of the app. The proxy
  must forward `X-Forwarded-Proto`, or invite pages will refuse to serve
  (SECURITY.md § Transport & headers).

## Configuration

Environment variables (a config file may set the same keys; env wins):

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8080` | Listen port |
| `HOST` | `0.0.0.0` | Listen address |
| `LOG_LEVEL` | `info` | pino level: fatal...trace, or silent |
| `CONFIG_FILE` | - | Optional JSON file setting the same keys (camelCase, nested `couchdb.*`); env wins |
| `DATA_DIR` | `/data` | SQLite database and master key location |
| `MASTER_KEY` | - | 32-byte key, base64. Overrides the key file; for injecting from a secret store |
| `MASTER_KEY_FILE` | `$DATA_DIR/master.key` | Key file, mode 0600; generated on first boot if absent |
| `COUCHDB_ADMIN_URL` | (required) | URL this app uses to reach CouchDB |
| `COUCHDB_ADMIN_USER` | (required) | CouchDB server-admin user |
| `COUCHDB_ADMIN_PASSWORD` | (required) | CouchDB server-admin password |
| `COUCHDB_PUBLIC_URL` | (required) | https URL devices replicate against; embedded in setup URIs |
| `PUBLIC_BASE_URL` | (required) | The app's own external URL; used to build invite links |
| `TRUST_PROXY` | `false` | Trust `X-Forwarded-*` from the immediate upstream; set `true` behind a proxy |
| `INVITE_TTL_MINUTES` | `15` | Invite link lifetime (max 1440) |

### The two CouchDB URLs (load-bearing)

`COUCHDB_ADMIN_URL` and `COUCHDB_PUBLIC_URL` are different in any real
deployment:

- **Admin URL**: where *this app* reaches CouchDB, usually a private
  address: `http://couchdb:5984` in compose,
  `http://couchdb.couchdb.svc.cluster.local:5984` in Kubernetes.
- **Public URL**: the https URL *devices* use, written into every setup URI
  as `couchDB_URI` (no trailing `/db`; LIVESYNC_INTEGRATION.md § 1). It must
  be reachable from every device you will onboard (LAN, VPN/tailnet, or
  public, your choice) and must be https.

Conflating them produces invites that work inside the network and fail
silently everywhere else.

## Docker Compose (recommended)

The repo ships a [compose.yaml](../compose.yaml) bundling the app and a
CouchDB, plus an optional Caddy proxy.

```sh
git clone <repo> && cd livesync-manager
cp .env.example .env    # edit: credentials + the two public URLs
docker compose up -d --build
```

Open http://localhost:8080 and complete first-boot setup, and do this promptly:
until the admin password is set, anyone who can reach the port could claim
the instance. Then use the "Apply recommended configuration" button to make
the bundled CouchDB LiveSync-ready (the compose file persists CouchDB's
`local.d`, so the fixes survive restarts).

- **Existing CouchDB?** Delete the `couchdb` service and the app's
  `depends_on`, and set `COUCHDB_ADMIN_URL` to your server.
- **TLS**: invite pages refuse plain HTTP except on localhost, so production
  needs a reverse proxy in front of the app (and devices need an https
  URL for CouchDB). Bring your own, or run the bundled Caddy:
  `docker compose --profile proxy up -d` with `MANAGER_DOMAIN` /
  `COUCHDB_DOMAIN` set in `.env` and both names resolving to the host.
  Bringing your own proxy instead: the app listens on
  `127.0.0.1:8080` and CouchDB on `127.0.0.1:5984`; terminate TLS for
  both (devices need an https URL to CouchDB too). Neither port is
  reachable from off the host.

## Plain docker run

```sh
docker run -d --name livesync-manager \
  -p 8080:8080 \
  -v livesync-manager-data:/data \
  -e COUCHDB_ADMIN_URL=http://couchdb:5984 \
  -e COUCHDB_ADMIN_USER=admin \
  -e COUCHDB_ADMIN_PASSWORD=... \
  -e COUCHDB_PUBLIC_URL=https://couchdb.example.com \
  -e PUBLIC_BASE_URL=https://livesync.example.com \
  -e TRUST_PROXY=true \
  <image>
```

Put a TLS-terminating proxy (Caddy, Traefik, nginx) in front; do not expose
the app port directly.

Keep `/data` on a local filesystem (named volume or bind mount to local
disk), never NFS/SMB; SQLite's locking and WAL shared-memory file do not
survive network filesystems.

## Backing up the app itself

Everything the app cannot recreate lives in `/data`: the SQLite database
and the master key. Back the volume up **as a unit**: the key decrypts the
database's secret columns, so one without the other is useless. Restore =
stop the container, replace `/data`, start. Losing `/data` entirely does not
lose notes (they live in CouchDB), but it loses every stored E2EE passphrase
and device credential, which is why each vault's passphrase also belongs in
your password manager (SECURITY.md). Snapshots of the CouchDB volume are a
separate concern and equally worth automating.

## Kubernetes

Kubernetes is the reference deployment, but nothing in the code may assume
it. The essentials of a working Deployment:

```yaml
spec:
  replicas: 1
  strategy: { type: Recreate }        # one SQLite writer, ever
  template:
    spec:
      securityContext:
        runAsNonRoot: true
        runAsUser: 1000               # the image's node user
        fsGroup: 1000
      containers:
        - name: livesync-manager
          image: <your-registry>/livesync-manager:<tag>
          env:
            - { name: COUCHDB_ADMIN_URL, value: http://couchdb.<ns>.svc:5984 }
            - { name: COUCHDB_PUBLIC_URL, value: https://couchdb.example.com }
            - { name: PUBLIC_BASE_URL, value: https://livesync.example.com }
            - { name: TRUST_PROXY, value: "true" }
            # COUCHDB_ADMIN_USER / COUCHDB_ADMIN_PASSWORD from a Secret
          readinessProbe: { httpGet: { path: /api/v1/health, port: 8080 } }
          livenessProbe: { httpGet: { path: /api/v1/health, port: 8080 } }
          volumeMounts: [{ name: data, mountPath: /data }]
      volumes:
        - name: data
          persistentVolumeClaim: { claimName: livesync-manager-data }
```

Notes for the manifest author:

- **Storage:** the `/data` PVC must be `ReadWriteOnce` on a local-block
  StorageClass (Longhorn, local-path, EBS, ...). Never NFS; `nolock` mounts
  and SQLite's mmap-backed `-shm` file make this a corruption risk, not a
  performance preference.
- **One replica, `strategy: Recreate`.** SQLite tolerates one writer; a
  rolling update would briefly run two pods against the same database file.
- **Probes:** liveness and readiness on `GET /api/v1/health`.
- **Ingress:** TLS at the ingress with forwarded headers enabled so
  `X-Forwarded-Proto` reaches the app; set `TRUST_PROXY=true`. The app holds
  E2EE passphrases and CouchDB admin credentials, so prefer non-public exposure
  (internal ingress, IP allowlist, VPN/tailnet).
- **Secrets:** inject `MASTER_KEY` and the CouchDB admin credentials from a
  Secret. External Secrets, 1Password Connect, sealed-secrets all work;
  they are just env vars to the app.
- **CouchDB config caveat:** if CouchDB's `local.ini` is managed declaratively
  (ConfigMap → init container → emptyDir is a common pattern), runtime config
  writes do not survive a CouchDB pod restart. The app's one-click config
  fix is then temporary: mirror the required settings into the declarative
  source and use the app's check as verification. See
  LIVESYNC_INTEGRATION.md § 2.
