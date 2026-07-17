# RELEASING.md

How a release is cut, and the gate it must pass. The criteria come from
AGENTS.md § Release Readiness; this file makes them executable.

## Versioning

Tags are `vMAJOR.MINOR.PATCH` (0.x while pre-1.0). `package.json` versions
track the tag. Every tag is a rollback point: rebuild the image from the tag
and roll the deployment.

## Pre-release checklist

Code and tests:

- [ ] `npm run lint && npm run typecheck && npm test`: clean
- [ ] Integration suite against a disposable CouchDB (never a real one):
      `docker compose -f dev/couchdb.yml up -d` (or `dev/couchdb-k8s.sh`),
      then `COUCHDB_TEST_ALLOW_CONFIG_MUTATION=1 npm run test:integration`
- [ ] `docker build .` succeeds and the image boots against the dev CouchDB
      (`compose.yaml` quickstart, first-boot through vault creation)
- [ ] `npm audit`: zero findings, or each one triaged in writing below the
      release notes

Hygiene:

- [ ] No secrets, private hostnames, or homelab-specific values in the repo:
      `grep -rniE "<your-domains>|<your-hosts>" --include='*.{md,ts,tsx,yaml,yml,json}' .`
- [ ] README states the trust model up front; SECURITY.md agrees with the code
- [ ] `reference/` attribution intact; dependencies pinned (`.npmrc`
      save-exact), including `octagonal-wheels`
- [ ] Supported LiveSync plugin version range checked against a current
      plugin release: decrypt a freshly minted setup URI in the plugin
      ("Use the copied setup URI") and confirm a device onboards

## Cutting the release

1. Bump `version` in `package.json` and `web/package.json`; commit.
2. `git tag vX.Y.Z && git push origin main --tags`.
3. Create the release on the forge with human-readable notes: what changed,
   any migration notes (the app migrates its own SQLite on boot), and the
   plugin version range tested.

## First GitHub publication

- Create the repository, push `main` and all tags.
- CI: `.github/workflows/ci.yml` is already in the repo, a mirror of the
  Forgejo workflow whose integration job uses a throwaway CouchDB service
  container, so it needs no repository secrets and runs on forks. (Not a
  symlink: GitHub Actions ignores symlinked workflow files.)
- Enable secret scanning and Dependabot alerts.
- The README, LICENSE (MIT), and this checklist are the release surface.
  Read them once more as a stranger would.
