// Deployment-facing configuration (hosh-deploy template mode, see DEPLOY.md):
// everything comes from env, nothing from file mounts.
import { describe, it, expect, vi } from 'vitest';
import { loadConfig } from '../src/server/config.ts';

const base = { NODE_ENV: 'test', APP_PEPPER: 'a'.repeat(32), SESSION_KEY: 'b'.repeat(32) };
const sa = { type: 'service_account', client_email: 'x@y.iam.gserviceaccount.com', private_key: '-----BEGIN PRIVATE KEY-----\nAAA\n-----END PRIVATE KEY-----\n' };
const b64 = Buffer.from(JSON.stringify(sa)).toString('base64');

describe('Google service account from env', () => {
  it('GOOGLE_SERVICE_ACCOUNT_JSON_B64 decodes to the inline JSON the mirror parses', () => {
    const c = loadConfig({ ...base, GOOGLE_SERVICE_ACCOUNT_JSON_B64: b64 });
    expect(JSON.parse(c.googleServiceAccountJson!)).toEqual(sa);
    expect(c.googleServiceAccountJson!.startsWith('{')).toBe(true);
  });

  it('GOOGLE_SERVICE_ACCOUNT_JSON (legacy path or inline) wins over the base64 form', () => {
    const c = loadConfig({ ...base, GOOGLE_SERVICE_ACCOUNT_JSON: '/run/secrets/google-sa.json', GOOGLE_SERVICE_ACCOUNT_JSON_B64: b64 });
    expect(c.googleServiceAccountJson).toBe('/run/secrets/google-sa.json');
  });

  it('an empty GOOGLE_SERVICE_ACCOUNT_JSON falls through to the base64 form', () => {
    const c = loadConfig({ ...base, GOOGLE_SERVICE_ACCOUNT_JSON: '', GOOGLE_SERVICE_ACCOUNT_JSON_B64: b64 });
    expect(JSON.parse(c.googleServiceAccountJson!)).toEqual(sa);
  });

  it('garbage base64 leaves the mirror unconfigured without logging the value', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const secretish = Buffer.from('not json at all').toString('base64');
      const c = loadConfig({ ...base, GOOGLE_SERVICE_ACCOUNT_JSON_B64: secretish });
      expect(c.googleServiceAccountJson).toBeNull();
      const logged = warn.mock.calls.flat().join(' ');
      expect(logged).toContain('GOOGLE_SERVICE_ACCOUNT_JSON_B64');
      expect(logged).not.toContain(secretish);
    } finally {
      warn.mockRestore();
    }
  });

  it('unset → unconfigured', () => {
    expect(loadConfig(base).googleServiceAccountJson).toBeNull();
  });
});

describe('listen port and data dir from env (legacy defaults kept)', () => {
  it('defaults: port 8080, DB and media under DATA_DIR', () => {
    const c = loadConfig({ ...base, DATA_DIR: '/data' });
    expect(c.port).toBe(8080);
    expect(c.dbPath).toBe('/data/storalex.db');
    expect(c.mediaDir).toBe('/data/media');
  });
  it('template mode: PORT=8000', () => {
    expect(loadConfig({ ...base, PORT: '8000', DATA_DIR: '/data' }).port).toBe(8000);
  });
  it('TRUST_PROXY accepts the box CIDR list', () => {
    expect(loadConfig({ ...base, TRUST_PROXY: '127.0.0.0/8,::1/128,172.16.0.0/12' }).trustProxy).toBe('127.0.0.0/8,::1/128,172.16.0.0/12');
  });
});
