// argon2id + pepper (SPEC §7.1). Guards @node-rs/argon2 upgrades and Node
// major bumps (prebuilt native binary): hashes stored in an existing DB must
// keep verifying, and the parameters must not silently drift.
import { describe, it, expect } from 'vitest';
import { hashPassword, verifyPassword } from '../src/server/auth/password.ts';

// Fake fixture values (not real secrets). The hash was produced by
// hashPassword() with @node-rs/argon2 2.0.2; it stands in for a row already
// stored in a production database.
const FIXTURE_PEPPER = 'fixture-pepper-not-a-real-secret';
const FIXTURE_PASSWORD = 'known-password-fixture';
const FIXTURE_HASH =
  '$argon2id$v=19$m=19456,t=2,p=1$+wyrrKWScc8SeXgbvPAluw$/mLuo9UpPdk/FO1eqSoEeoDgBAdScFL1HwtlI7YzmTE';

const PEPPER = 'p'.repeat(32);

describe('password hashing', () => {
  it('produces an argon2id v19 PHC string with the pinned cost parameters', async () => {
    const h = await hashPassword('correct horse', PEPPER);
    expect(h).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$[A-Za-z0-9+/]{22}\$[A-Za-z0-9+/]{43}$/);
  });

  it('salts every hash (same input -> different hashes)', async () => {
    expect(await hashPassword('same', PEPPER)).not.toBe(await hashPassword('same', PEPPER));
  });

  it('round-trips with the right password and pepper', async () => {
    const h = await hashPassword('correct horse', PEPPER);
    expect(await verifyPassword(h, 'correct horse', PEPPER)).toBe(true);
  });

  it('rejects a wrong password', async () => {
    const h = await hashPassword('correct horse', PEPPER);
    expect(await verifyPassword(h, 'wrong horse', PEPPER)).toBe(false);
  });

  it('rejects the right password with a different pepper (pepper is a keyed secret)', async () => {
    const h = await hashPassword('correct horse', PEPPER);
    expect(await verifyPassword(h, 'correct horse', 'q'.repeat(32))).toBe(false);
  });

  it('handles unicode passwords', async () => {
    const h = await hashPassword('mot de passe é ü 🔑', PEPPER);
    expect(await verifyPassword(h, 'mot de passe é ü 🔑', PEPPER)).toBe(true);
    expect(await verifyPassword(h, 'mot de passe e u 🔑', PEPPER)).toBe(false);
  });

  it('returns false (never throws) for malformed stored hashes', async () => {
    for (const bad of ['', 'not-a-hash', '$argon2id$v=19$m=1$garbage', '$2b$10$abcdefghijklmnopqrstuv']) {
      expect(await verifyPassword(bad, 'x', PEPPER)).toBe(false);
    }
  });
});

describe('previously stored hash (backward compatibility)', () => {
  it('still verifies with its pepper', async () => {
    expect(await verifyPassword(FIXTURE_HASH, FIXTURE_PASSWORD, FIXTURE_PEPPER)).toBe(true);
  });
  it('still rejects a wrong password or pepper', async () => {
    expect(await verifyPassword(FIXTURE_HASH, FIXTURE_PASSWORD + 'x', FIXTURE_PEPPER)).toBe(false);
    expect(await verifyPassword(FIXTURE_HASH, FIXTURE_PASSWORD, PEPPER)).toBe(false);
  });
});
