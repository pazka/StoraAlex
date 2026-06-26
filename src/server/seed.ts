import { fileURLToPath } from 'node:url';
import { loadConfig, loadEnvFile, type Config } from './config.js';
import { openDb, type DB } from './db/index.js';
import { createRepos } from './db/repos.js';
import { hashPassword } from './auth/password.js';

/**
 * Create the first admin user from SEED_ADMIN_USER/PASSWORD, but only if no
 * users exist yet. No public signup exists, so this is the bootstrap path.
 */
export async function runSeed(config: Config, db: DB): Promise<void> {
  const repos = createRepos(db);
  if (repos.users.count() > 0) return;

  if (!config.seedAdminUser || !config.seedAdminPassword) {
    console.warn(
      '[seed] No users exist and SEED_ADMIN_USER/SEED_ADMIN_PASSWORD are not set. ' +
        'Set them and restart (or run `npm run seed`) to create the first admin.',
    );
    return;
  }

  const hash = await hashPassword(config.seedAdminPassword, config.appPepper);
  repos.users.create(config.seedAdminUser, hash);
  console.log(`[seed] Created admin user "${config.seedAdminUser}".`);
}

// Allow running standalone: `npm run seed`
const isMain = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  loadEnvFile();
  const config = loadConfig();
  const db = openDb(config.dbPath);
  await runSeed(config, db);
  db.close();
}
