import { randomBytes, createHash } from 'node:crypto';

const BASE_COOKIE = 'storalex_sid';
export const SESSION_COOKIE = BASE_COOKIE; // dev / non-prod name

/**
 * In production use the `__Host-` cookie prefix, which the browser only accepts
 * when the cookie is Secure, Path=/, and has no Domain — blocking a sibling
 * subdomain (e.g. on a shared parent like hosh.it) from injecting or overwriting
 * the session cookie. In dev (http://localhost, no Secure) the prefix isn't
 * allowed, so fall back to the bare name.
 */
export function sessionCookieName(isProd: boolean): string {
  return isProd ? `__Host-${BASE_COOKIE}` : BASE_COOKIE;
}

/** A fresh, high-entropy session token (carried in the signed cookie). */
export function newSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * The token is never stored; we store its sha256 so a database leak does not
 * hand out live sessions. Lookups hash the incoming cookie value the same way.
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function expiryFromNow(days: number): string {
  const d = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
  return d.toISOString().replace('T', ' ').slice(0, 19); // match SQLite datetime() text
}
