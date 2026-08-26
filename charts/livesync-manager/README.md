# LiveSync Manager Helm chart

This chart deploys one LiveSync Manager replica with a `ReadWriteOnce` PVC and
the `Recreate` update strategy. Those are data-integrity requirements: the
application uses SQLite and must never have two writers sharing `/data`.

## Install

Create a Secret outside Helm. Do not put credentials or `MASTER_KEY` in values
files committed to source control.

```sh
kubectl -n livesync create secret generic livesync-manager-secrets \
  --from-literal=COUCHDB_ADMIN_USER=admin \
  --from-literal=COUCHDB_ADMIN_PASSWORD='replace-me' \
  --from-literal=MASTER_KEY='base64-encoded-32-byte-key'

helm upgrade --install livesync-manager charts/livesync-manager \
  --namespace livesync --create-namespace \
  --set existingSecret=livesync-manager-secrets \
  --set image.repository=registry.example.com/livesync-manager \
  --set image.tag=0.3.1 \
  --set config.couchdb.adminUrl=http://couchdb.couchdb.svc.cluster.local:5984 \
  --set config.couchdb.publicUrl=https://couchdb.example.com \
  --set config.publicBaseUrl=https://livesync.example.com
```

Use a block-storage `ReadWriteOnce` StorageClass. Do not use NFS for `/data`.

## Optional access-log telemetry RBAC

`telemetry.couchdbLogs` is disabled by default. When the application gains the
optional log reader, enabling both `enabled` and `createRbac` creates a
cross-namespace Role and RoleBinding granting the manager `get/list` on pods
and `get` on pod logs in the configured CouchDB namespace. Access logs can
contain source IP addresses, so enable it only inside the same trust boundary.

```yaml
telemetry:
  couchdbLogs:
    enabled: true
    createRbac: true
    namespace: couchdb
```
