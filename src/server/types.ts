import 'fastify';
import type { Repos } from './db/repos.js';
import type { Config } from './config.js';
import type { DB } from './db/index.js';
import type { SheetMirror } from './lib/sheet.js';
import type { Logger } from './lib/log.js';
import type { User } from '../shared/types.js';

declare module 'fastify' {
  interface FastifyInstance {
    repos: Repos;
    appConfig: Config;
    db: DB;
    sheetMirror: SheetMirror;
    logger: Logger;
  }
  interface FastifyRequest {
    // Populated by the auth hook for protected routes; null otherwise.
    user: User | null;
  }
}
