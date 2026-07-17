# SPEC.md

# Overview

This project is a self-hosted management application for Obsidian LiveSync.

Its goal is to make LiveSync setup, maintenance, and recovery nearly effortless while preserving the flexibility of CouchDB.

The project does not replace LiveSync.

Instead, it manages the infrastructure around it.

---

# Goals

The application should allow a user to:

* Create a new vault.
* Connect an existing vault.
* Add a new device.
* Monitor synchronization.
* Manage CouchDB.
* Create backups.
* Restore backups.
* Rotate credentials.
* View device status.

---

# Non-Goals

The application will not:

* Replace Obsidian.
* Replace LiveSync.
* Synchronize notes directly.
* Edit vault contents.
* Perform conflict resolution.

---

# MVP

## Dashboard

Display:

* Vaults
* Connected devices
* CouchDB health
* Backup status
* Recent events

---

## Vault Management

Create vault

* Generate database
* Generate credentials
* Store metadata
* Generate encryption key
* Generate onboarding link

Existing vault

* Connect existing database
* Verify LiveSync metadata
* Import configuration

Archive vault

* Hide from dashboard
* Preserve data

Delete vault

* Multi-step confirmation
* Optional backup first

---

## Device Management

Each device should have:

* Name
* Platform
* First connected
* Last seen
* Status

Actions:

* Add device
* Revoke device
* Regenerate onboarding link

---

## Onboarding

The preferred onboarding flow is:

Dashboard

↓

Select vault

↓

Add Device

↓

Generate secure temporary setup link

↓

Open on new device

↓

LiveSync imports configuration

↓

Device downloads vault

The application should never require users to manually enter CouchDB settings.

---

## CouchDB Management

Support:

* Database creation
* User creation
* Password rotation
* Health checks
* Connectivity testing

Avoid exposing raw CouchDB administration unless necessary.

---

## Backup

Support:

* Manual backup
* Scheduled backup
* Restore preview
* Backup verification

Potential future targets:

* Local filesystem
* S3-compatible storage
* Restic
* Borg

---

## Health Monitoring

Checks should include:

* CouchDB reachable
* Replication healthy
* Database size
* Disk usage
* Backup freshness

Warnings should be understandable.

Example:

"Backups are 9 days old."

instead of

"Cron job failed."

---

## Security

* HTTPS required
* Secure session authentication
* Secrets encrypted at rest
* Temporary onboarding links
* Expiring QR codes
* Audit log

---

# Nice-to-Have

* Push notifications
* Mobile admin UI
* Docker installer
* Reverse proxy setup wizard
* Automatic CouchDB updates
* Vault statistics
* Sync history visualization

---

# Future Integrations

Possible future integrations:

* Tailscale
* Cloudflare Tunnel
* Traefik
* Caddy
* Prometheus
* Grafana
* Home Assistant

---

# Success Criteria

The project is successful if a user can:

1. Install the application.
2. Create a vault.
3. Scan a QR code on a new device.
4. Watch the vault download automatically.
5. Never manually configure CouchDB.

