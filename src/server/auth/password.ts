import { hash, verify } from '@node-rs/argon2';

// @node-rs/argon2 defaults to argon2id (algorithm 2) at version 0x13, which is
// exactly what SPEC §7.1 requires, so we rely on those defaults rather than
// importing the const enums (which clash with verbatimModuleSyntax).
// The server-side pepper is applied via argon2's keyed mode ("secret"), NOT
// string concatenation, and never touches the database.
// memoryCost is in KiB: 19456 KiB = 19 MiB (OWASP minimum for argon2id).
function options(pepper: string) {
  return {
    memoryCost: 19456,
    timeCost: 2,
    parallelism: 1,
    secret: Buffer.from(pepper, 'utf8'),
  };
}

export function hashPassword(password: string, pepper: string): Promise<string> {
  return hash(password, options(pepper));
}

export async function verifyPassword(stored: string, password: string, pepper: string): Promise<boolean> {
  try {
    return await verify(stored, password, options(pepper));
  } catch {
    // Malformed hash or mismatch — never throw to the caller.
    return false;
  }
}
