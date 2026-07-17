import path from 'node:path';
import { loadConfig } from './config/index.js';
import { loadMasterKey } from './config/masterKey.js';
import { CouchClient } from './couch/client.js';
import { openDatabase } from './db/index.js';
import { defaultMigrationsDir, runMigrations } from './db/migrations.js';
import { buildServer } from './server.js';
import { HealthMonitor } from './services/health.js';
import { BackupScheduler } from './services/scheduler.js';

const HEALTH_POLL_INTERVAL_MS = 60_000;

let config;
try {
  config = loadConfig();
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}

const masterKey = loadMasterKey(config);
const db = openDatabase(path.join(config.dataDir, 'livesync-console.db'));
const migrated = runMigrations(db, defaultMigrationsDir());
const couch = new CouchClient({
  url: config.couchdb.adminUrl,
  user: config.couchdb.adminUser,
  password: config.couchdb.adminPassword,
});
const health = new HealthMonitor(couch);

const server = await buildServer({ config, db, masterKey: masterKey.key, couch, health });
health.start(HEALTH_POLL_INTERVAL_MS);
const scheduler = new BackupScheduler({ db, couch, config }, (err, vaultId) =>
  server.log.error({ vaultId }, `Scheduled backup failed: ${err.message}`),
);
scheduler.start();

if (masterKey.source === 'generated') {
  server.log.warn(
    `Generated a new master key in ${config.dataDir}. Back up the data directory now; ` +
      `losing the key loses every stored passphrase and credential.`,
  );
}
if (masterKey.warning) {
  server.log.warn(masterKey.warning);
}
for (const name of migrated) {
  server.log.info(`Applied migration ${name}`);
}

try {
  await server.listen({ port: config.port, host: config.host });
} catch (err) {
  server.log.error(err);
  process.exit(1);
}
