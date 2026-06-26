import { loadConfig, loadEnvFile } from './config.js';
import { openDb } from './db/index.js';
import { buildApp } from './app.js';

loadEnvFile();
const config = loadConfig();
const db = openDb(config.dbPath);
// No admin is seeded: on first run (no users) the app prompts to create the
// first account via /api/auth/setup. See routes/auth.ts.

const app = await buildApp(config, db);

// Periodically drop expired sessions.
const prune = setInterval(() => {
  try {
    app.repos.sessions.deleteExpired();
  } catch (err) {
    app.log.warn({ err }, 'session prune failed');
  }
}, 60 * 60 * 1000);
prune.unref();

// Google Sheet mirror: push once on boot, then reconcile periodically (the
// debounced on-change push handles freshness between reconciles).
if (app.sheetMirror.configured) {
  app.sheetMirror.exportNow().catch((err) => app.log.warn(`initial sheet sync failed: ${(err as Error).message}`));
  const reconcile = setInterval(
    () => void app.sheetMirror.exportNow().catch((err) => app.log.warn(`sheet sync failed: ${(err as Error).message}`)),
    5 * 60 * 1000,
  );
  reconcile.unref();
}

try {
  await app.listen({ port: config.port, host: config.host });
  app.log.info(`StorAlex listening on http://${config.host}:${config.port} (env=${config.env})`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}

async function shutdown() {
  clearInterval(prune);
  await app.close();
  try {
    db.close();
  } catch {
    /* already closed */
  }
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
