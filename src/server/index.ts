import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, loadEnvFile } from './config.js';
import { openDb } from './db/index.js';
import { buildApp } from './app.js';
import { configNamesSet, errField, log, reconfigureLog } from './lib/log.js';
import { pruneSessions } from './lib/jobs.js';

loadEnvFile();
reconfigureLog(); // LOG_LEVEL / APP_LOG_LEVEL / APP_VERSION set only in a local .env
const config = loadConfig();
const db = openDb(config.dbPath);
// No admin is seeded: on first run (no users) the app prompts to create the
// first account via /api/auth/setup. See routes/auth.ts.

const app = await buildApp(config, db);

// Periodically drop expired sessions (one line at start and at end: logging standard).
const prune = setInterval(() => pruneSessions(app.repos, log), 60 * 60 * 1000);
prune.unref();

// Google Sheet mirror: push once on boot, then reconcile periodically (the
// debounced on-change push handles freshness between reconciles). sync() logs its own lines.
let reconcile: ReturnType<typeof setInterval> | undefined;
if (app.sheetMirror.configured) {
  void app.sheetMirror.sync('boot');
  reconcile = setInterval(() => void app.sheetMirror.sync('reconcile'), 5 * 60 * 1000);
  reconcile.unref();
}

function writable(dir: string): boolean {
  try {
    fs.accessSync(dir, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

try {
  await app.listen({ port: config.port, host: config.host });
  log.info('startup', 'StorAlex listening', {
    port: config.port,
    env: config.env,
    data_dir_writable: writable(config.dbPath === ':memory:' ? config.dataDir : path.dirname(config.dbPath)),
    sheet_mirror: app.sheetMirror.configured,
    log_level: log.level,
    config: configNamesSet(),
  });
} catch (err) {
  log.error('startup_failed', 'could not listen', { port: config.port, ...errField(err) });
  process.exit(1);
}

async function shutdown(signal: string) {
  log.info('shutdown', 'StorAlex stopping', { signal });
  clearInterval(prune);
  if (reconcile) clearInterval(reconcile);
  await app.close();
  try {
    db.close();
  } catch {
    /* already closed */
  }
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
