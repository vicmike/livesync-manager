# AGENTS.md

## Project Philosophy

This project exists to make self-hosted Obsidian LiveSync feel as simple as Obsidian Sync while remaining completely self-hosted.

The application should never replace LiveSync or CouchDB. Instead, it should provision, manage, and simplify them.

Every design decision should reduce the number of ways a user can accidentally lose data or create an invalid synchronization state.

---

# Core Principles

1. Safety over convenience.
2. Recoverability over cleverness.
3. Simple defaults.
4. Transparent operations.
5. Minimize manual configuration.

If an operation could overwrite or destroy notes, the application should require explicit confirmation and clearly explain what will happen.

---

# User Model

The primary user is an individual running one or more Obsidian vaults on their own infrastructure.

This is **not** intended to be multi-tenant SaaS.

Assume:

* one administrator
* multiple devices
* multiple vaults
* self-hosted CouchDB

Future support for families or teams should not complicate the initial architecture.

---

# Responsibilities

The application is responsible for:

* Creating CouchDB databases.
* Managing CouchDB users.
* Managing vault metadata.
* Generating LiveSync setup links.
* Device onboarding.
* Health monitoring.
* Backup coordination.
* Safe recovery workflows.

The application is **not** responsible for:

* Editing notes.
* Replacing LiveSync.
* Sync conflict resolution.
* Reimplementing CouchDB replication.

---

# Architecture

Favor modular services.

Suggested modules:

* API
* Web UI
* CouchDB client
* Vault manager
* Device manager
* Backup manager
* Health monitor
* Configuration manager

Avoid tightly coupling these modules.

---

# AI Coding Guidelines

When making changes:

* Prefer incremental PR-sized changes.
* Avoid introducing unnecessary frameworks.
* Keep dependencies minimal.
* Document every new API.
* Write tests for business logic.
* Avoid hidden behavior.
* Prefer explicit state transitions.

---

# Safety Rules

Never automatically:

* overwrite an existing vault
* delete a CouchDB database
* rotate encryption keys
* change replication settings

Always require explicit confirmation.

---

# UI Philosophy

The UI should answer four questions immediately:

1. Are my notes safe?
2. Are my devices synced?
3. Are backups healthy?
4. Can I safely add another device?

Everything else is secondary.

---

# Logging

Operations should be human-readable.

Good:

"Created vault Personal."

Bad:

"HTTP 201."

Good:

"Device iPad successfully connected."

Bad:

"Replication initialized."

---

# Future Features

Design for, but do not prematurely implement:

* Multiple servers
* Multiple CouchDB clusters
* S3 backups
* Team support
* Mobile-friendly administration
* Plugin integrations

---

# Definition of Done

A feature is complete when:

* It has tests.
* It has documentation.
* It cannot silently destroy user data.
* Errors are actionable.
* The UI explains what happened.

---

# Release Readiness

This project will be published as open source (MIT). The public release is
done when:

* `LICENSE` is present and `reference/` carries upstream attribution.
* No secrets, private hostnames, or homelab-specific values anywhere in the
  repo; deployment examples use `example.com`.
* The README states the trust model up front (the app stores E2EE
  passphrases; see SECURITY.md).
* Code reads like a careful human wrote it: no narration comments, no emoji,
  no boilerplate docstrings, no dead code or commented-out blocks. Comments
  state constraints the code can't, nothing else.
* CI is green: lint, unit tests, CouchDB integration tests.
* `npm audit` is clean or every finding is triaged in writing.
* Dependencies are pinned, including `octagonal-wheels`, and the supported
  LiveSync plugin version range is documented and tested.

