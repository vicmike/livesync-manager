#!/usr/bin/env sh
# Disposable CouchDB for integration tests, on a Kubernetes cluster, for
# machines without a local container runtime. Creates a throwaway namespace,
# port-forwards localhost:5984, and deletes everything on exit.
#
#   ./dev/couchdb-k8s.sh          # Ctrl-C to stop and tear down
#   npm run test:integration      # in another terminal
set -eu

NS=livesync-manager-couchdb-test

kubectl create namespace "$NS" --dry-run=client -o yaml | kubectl apply -f -
PF=""
# The port-forward runs in the background and is waited on, so a signal to
# this script (Ctrl-C, or a wrapper's kill) is handled immediately instead of
# being deferred until the foreground child exits, which left the namespace
# behind.
trap 'if [ -n "$PF" ]; then kill "$PF" 2>/dev/null; fi; kubectl delete namespace "$NS" --wait=false' EXIT INT TERM

kubectl -n "$NS" run couchdb --image=couchdb:3 --port=5984 --restart=Never \
  --env=COUCHDB_USER=admin --env=COUCHDB_PASSWORD=admin
kubectl -n "$NS" wait --for=condition=Ready pod/couchdb --timeout=180s

echo "Disposable CouchDB ready at http://admin:admin@localhost:5984 (Ctrl-C to tear down)"
kubectl -n "$NS" port-forward pod/couchdb 5984:5984 &
PF=$!
wait "$PF"
