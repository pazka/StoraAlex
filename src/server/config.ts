import { randomBytes } from 'node:crypto';
import path from 'node:path';

export interface Config {
  env: 'development' | 'production' | 'test';
  isProd: boolean;
  port: number;
  host: string;
  // boolean | hop-count | IP/CIDR. A bare `true` trusts the whole X-Forwarded-For
  // chain (client-spoofable); prefer a hop count (1 = one reverse proxy).
  trustProxy: boolean | number | string;
  dataDir: string;
  dbPath: string;
  mediaDir: string;
  appPepper: string;
  sessionKey: string;
  sessionTtlDays: number;
  seedAdminUser: string | null;
  seedAdminPassword: string | null;
  // Google Sheet mirror (M7 — deferred; left unconfigured for now).
  sheetId: string | null;
  googleServiceAccountJson: string | null;
  sheetSyncDebounceMs: number;
  // Max upload size for a single photo, bytes.
  maxUploadBytes: number;
}

/** Load a local .env into process.env if present (no-op when missing). */
export function loadEnvFile(): void {
  try {
    process.loadEnvFile();
  } catch {
    /* no .env file — fine, rely on the ambient environment */
  }
}

function bool(v: string | undefined, dflt: boolean): boolean {
  if (v === undefined) return dflt;
  return v === '1' || v.toLowerCase() === 'true' || v.toLowerCase() === 'yes';
}

function int(v: string | undefined, dflt: number): number {
  const n = v === undefined ? NaN : Number(v);
  return Number.isFinite(n) ? n : dflt;
}

/**
 * Resolve the Fastify `trustProxy` setting. A bare `true` makes req.ip the
 * left-most (client-controlled) X-Forwarded-For value, which lets a client spoof
 * its IP and defeat per-IP rate limiting. So prefer a hop count: default 1 in
 * production (a single reverse proxy), false in dev. `TRUST_PROXY` accepts a
 * number of hops, an IP/CIDR (or comma list), or true/false.
 */
function parseTrustProxy(v: string | undefined, isProd: boolean): boolean | number | string {
  if (v === undefined || v.trim() === '') return isProd ? 1 : false;
  const t = v.trim();
  if (t.toLowerCase() === 'true') return true;
  if (t.toLowerCase() === 'false') return false;
  if (/^\d+$/.test(t)) return Number(t);
  return t; // IP / CIDR / comma-separated list
}

/**
 * Build the runtime config from the environment.
 * In production the security-critical secrets are required and the process
 * refuses to start without them. In dev/test we fall back to ephemeral values.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const nodeEnv = (env.NODE_ENV as Config['env']) || 'development';
  const isProd = nodeEnv === 'production';

  const dataDir = env.DATA_DIR || path.resolve(process.cwd(), 'data');

  const missing: string[] = [];
  function requiredSecret(name: string): string {
    const val = env[name];
    if (val && val.length >= 16) return val;
    if (isProd) {
      missing.push(name);
      return '';
    }
    // Dev/test: generate an ephemeral secret so the app can boot. Sessions/
    // hashes will not survive a restart, which is fine outside production.
    // Make it loud so a misconfigured prod (NODE_ENV not exactly 'production')
    // doesn't silently rotate secrets every restart.
    console.warn(
      `[config] WARNING: ${name} is unset — generating an EPHEMERAL value (env=${nodeEnv}). ` +
        `Sessions and password hashes will not survive a restart. Set ${name} for stable behavior; ` +
        `a real deployment must run with NODE_ENV=production and ${name} set.`,
    );
    return randomBytes(32).toString('hex');
  }

  const appPepper = requiredSecret('APP_PEPPER');
  const sessionKey = requiredSecret('SESSION_KEY');

  if (missing.length > 0) {
    throw new Error(
      `Missing required secrets in production: ${missing.join(', ')}. ` +
        `Generate strong random values (>=16 chars) and set them in the environment. See .env.example.`,
    );
  }

  return {
    env: nodeEnv,
    isProd,
    port: int(env.PORT, 8080),
    host: env.HOST || '0.0.0.0',
    trustProxy: parseTrustProxy(env.TRUST_PROXY, isProd),
    dataDir,
    dbPath: env.DB_PATH || path.join(dataDir, 'storalex.db'),
    mediaDir: env.MEDIA_DIR || path.join(dataDir, 'media'),
    appPepper,
    sessionKey,
    sessionTtlDays: int(env.SESSION_TTL_DAYS, 30),
    seedAdminUser: env.SEED_ADMIN_USER || null,
    seedAdminPassword: env.SEED_ADMIN_PASSWORD || null,
    sheetId: env.SHEET_ID || null,
    googleServiceAccountJson: env.GOOGLE_SERVICE_ACCOUNT_JSON || null,
    sheetSyncDebounceMs: int(env.SHEET_SYNC_DEBOUNCE_MS, 10000),
    maxUploadBytes: int(env.MAX_UPLOAD_BYTES, 15 * 1024 * 1024),
  };
}
