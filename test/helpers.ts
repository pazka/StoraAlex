import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '../src/server/config.ts';
import { openDb } from '../src/server/db/index.ts';
import { buildApp } from '../src/server/app.ts';
import { createRepos } from '../src/server/db/repos.ts';
import { hashPassword } from '../src/server/auth/password.ts';

export const TEST_USER = 'tester';
export const TEST_PW = 'pw-12345678';

export const TEST_PEPPER = 'a'.repeat(32);
export const TEST_SESSION_KEY = 'b'.repeat(32);

/** Fresh in-memory app. `env` overrides/extends the fake test environment. */
export async function makeApp({ seed = true, env = {} }: { seed?: boolean; env?: NodeJS.ProcessEnv } = {}) {
  const mediaDir = fs.mkdtempSync(path.join(os.tmpdir(), 'storalex-test-'));
  const config = loadConfig({
    NODE_ENV: 'test',
    APP_PEPPER: TEST_PEPPER,
    SESSION_KEY: TEST_SESSION_KEY,
    DB_PATH: ':memory:',
    DATA_DIR: mediaDir,
    MEDIA_DIR: mediaDir,
    ...env,
  });
  const db = openDb(config.dbPath);
  const repos = createRepos(db);
  if (seed) repos.users.create(TEST_USER, await hashPassword(TEST_PW, config.appPepper));
  const app = await buildApp(config, db);
  await app.ready();
  return { app, config, db, mediaDir };
}

/** Log in and return a Cookie header string for authenticated inject() calls. */
export async function loginCookie(app: FastifyInstance): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: TEST_USER, password: TEST_PW },
  });
  if (res.statusCode !== 200) throw new Error(`login failed: ${res.statusCode} ${res.body}`);
  const sid = res.cookies.find((c) => c.name === 'storalex_sid');
  if (!sid) throw new Error('no session cookie set');
  return `storalex_sid=${sid.value}`;
}
