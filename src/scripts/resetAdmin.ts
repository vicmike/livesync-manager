import { existsSync } from 'node:fs';
import path from 'node:path';
import { openDatabase } from '../db/index.js';
import { recordEvent } from '../services/events.js';

// Clears the admin password so the app falls back to first-boot setup,
// where a new password can be chosen. Every session is dropped too, so any
// existing login stops working immediately. This is the supported recovery
// path when the admin password is lost (docs/SECURITY.md).
//
// Run it inside the running container, against the same data directory the
// app uses. It needs only that directory (DATA_DIR, default /data), not the
// CouchDB credentials:
//
//   docker compose exec app npm run reset-admin
//   kubectl exec -n <namespace> deploy/livesync-manager -- npm run reset-admin
//
// Anyone who can run this already has the data directory and could read the
// master key, so it deliberately asks for no further proof of identity. The
// exposure it opens is the first-boot window: set the new password promptly.

const dataDir = process.env.DATA_DIR ?? '/data';
const dbFile = path.join(dataDir, 'livesync-console.db');

if (!existsSync(dbFile)) {
  console.error(
    `No database at ${dbFile}. Set DATA_DIR to the directory that holds ` +
      `livesync-console.db (the volume mounted at /data in production).`,
  );
  process.exit(1);
}

const db = openDatabase(dbFile);

const hasSettings = db
  .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'app_settings'")
  .get();
if (!hasSettings) {
  console.error(
    `${dbFile} has no app_settings table, so it is not a LiveSync Manager database. ` +
      `Check that DATA_DIR points at the right directory.`,
  );
  process.exit(1);
}

const clearedPassword = db
  .prepare("DELETE FROM app_settings WHERE key = 'admin_password_hash'")
  .run().changes;
const clearedSessions = db.prepare('DELETE FROM sessions').run().changes;

recordEvent(db, {
  level: 'warn',
  actor: 'admin',
  message: 'Admin password reset from the command line (all sessions ended)',
});

if (clearedPassword === 0) {
  console.log('No admin password was set; the app is already at first-boot setup.');
} else {
  console.log('Admin password cleared.');
}
console.log(`Signed out ${clearedSessions} active session(s).`);
console.log('Now open the app and set a new password on the first-boot screen, promptly.');
