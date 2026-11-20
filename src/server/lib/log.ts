// Logging standard (pazka/hosh-management AGENTS.md section 11): stdout only, one JSON object per line with
// ts, level, service, version, event (stable snake_case name, the thing to count), msg, then the line's own
// fields. Never a secret, a token, a cookie, a request body, an e-mail address, a username, an IP, a raw
// path or a query string: requests are named by their route template.
import crypto from 'node:crypto';

export const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
export type Level = keyof typeof LEVELS;
export const SERVICE = 'storalex';
/** A request slower than this is logged at warn. */
export const SLOW_MS = 1000;
/** The variables the server reads: the startup line lists the ones that are set, never their values. */
export const CONFIG_NAMES = [
  'NODE_ENV',
  'HOST',
  'PORT',
  'DATA_DIR',
  'DB_PATH',
  'MEDIA_DIR',
  'TRUST_PROXY',
  'APP_PEPPER',
  'SESSION_KEY',
  'SESSION_TTL_DAYS',
  'MAX_UPLOAD_BYTES',
  'SEED_ADMIN_USER',
  'SEED_ADMIN_PASSWORD',
  'SHEET_ID',
  'GOOGLE_SERVICE_ACCOUNT_JSON',
  'GOOGLE_SERVICE_ACCOUNT_JSON_B64',
  'SHEET_SYNC_DEBOUNCE_MS',
  'LOG_LEVEL',
  'APP_LOG_LEVEL',
  'APP_VERSION',
];

export type Fields = Record<string, unknown>;
type Emit = (event: string, msg: string, fields?: Fields) => void;
export type Logger = { level: Level; debug: Emit; info: Emit; warn: Emit; error: Emit };

/** level: debug | info | warn | error (anything else: info). */
export function createLogger(level: string, out: { write: (s: string) => unknown }, version: string): Logger {
  const name: Level = level in LEVELS ? (level as Level) : 'info';
  const min = LEVELS[name];
  const emit =
    (lvl: Level): Emit =>
    (event, msg, fields = {}) => {
      if (LEVELS[lvl] < min) return;
      out.write(
        JSON.stringify({ ts: new Date().toISOString(), level: lvl, service: SERVICE, version, event, msg, ...fields }) +
          '\n',
      );
    };
  return { level: name, debug: emit('debug'), info: emit('info'), warn: emit('warn'), error: emit('error') };
}

/** LOG_LEVEL, or APP_LOG_LEVEL (the name the box template passes), default info. */
export function levelFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  return env.LOG_LEVEL || env.APP_LOG_LEVEL || 'info';
}

export const log = createLogger(levelFromEnv(), process.stdout, process.env.APP_VERSION || 'dev');

/** A logger that writes nothing (unit tests). */
export const silentLogger = createLogger('error', { write: () => true }, 'test');
silentLogger.error = () => {};

export function configNamesSet(env: NodeJS.ProcessEnv = process.env): string[] {
  return CONFIG_NAMES.filter((n) => env[n] !== undefined && env[n] !== '');
}

/**
 * The `err` field of an error line: type, message, code, and the stack's "at ..." frames.
 * Each string of `hide` (a raw URL, a path...) is replaced by "<hidden>".
 */
export function errField(e: unknown, hide: string[] = []): { err: Fields } {
  const secrets = hide.filter((h) => typeof h === 'string' && h.length > 1).sort((a, b) => b.length - a.length);
  // e-mail addresses (e.g. a Google service account named in a Sheet error) never reach a log
  const clean = (s: unknown) =>
    secrets
      .reduce((t, h) => t.split(h).join('<hidden>'), String(s))
      .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '<email>');
  if (e instanceof Error) {
    const type = e.name || 'Error';
    const message = clean(e.message);
    const frames = String(e.stack || '')
      .split('\n')
      .filter((l) => /^\s+at /.test(l))
      .map(clean);
    const err: Fields = { type, message, stack: [`${type}: ${message}`, ...frames].join('\n') };
    const code = (e as { code?: unknown }).code;
    if (code) err.code = String(code);
    return { err };
  }
  return { err: { type: typeof e, message: clean(e) } };
}

/** The edge's X-Request-Id when it is a plain token of at most 64 characters, else a new one. */
export function requestId(header: string | string[] | undefined): string {
  const v = Array.isArray(header) ? header[0] : header;
  return typeof v === 'string' && /^[A-Za-z0-9._:-]{1,64}$/.test(v) ? v : crypto.randomUUID();
}
