import { loadConfig, loadEnvFile } from './config.js';
import { openDb } from './db/index.js';
import { buildApp } from './app.js';
import { runSeed } from './seed.js';

loadEnvFile();
const config = loadConfig();
const db = openDb(config.dbPath);
await runSeed(config, db);

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
