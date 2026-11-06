// Post-deploy capability smoke (hosh-deploy POST_DEPLOY, see deploy/hosh-deploy.conf).
// Runs INSIDE the freshly deployed container, after it is healthy and before the release is
// accepted; a non-zero exit makes hosh-deploy roll back. It must never change live data, so it
// only reads over HTTP and exercises the native modules in memory:
//   node /app/dist/server/postdeploy.js http://127.0.0.1:8000
import sharp from 'sharp';
import { hash, verify } from '@node-rs/argon2';

const base = (process.argv[2] ?? `http://127.0.0.1:${process.env.PORT ?? 8080}`).replace(/\/$/, '');
let failed = 0;

async function check(name: string, fn: () => Promise<string | void>): Promise<void> {
  try {
    const detail = await fn();
    console.log(`ok   ${name}${detail ? ` (${detail})` : ''}`);
  } catch (err) {
    failed++;
    console.log(`FAIL ${name}: ${(err as Error).message}`);
  }
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

async function get(path: string, init?: RequestInit): Promise<Response> {
  return fetch(base + path, { redirect: 'manual', signal: AbortSignal.timeout(10_000), ...init });
}

await check('GET /healthz: DB answers, storage writable', async () => {
  const r = await get('/healthz');
  const body = (await r.json()) as Record<string, unknown>;
  assert(r.status === 200 && body.status === 'ok', `HTTP ${r.status} ${JSON.stringify(body)}`);
  assert(body.db === 'ok' && body.storage === 'writable', JSON.stringify(body));
  return `migrations=${String(body.migrations)}`;
});

let asset = '';
await check('GET /: PWA shell + CSP', async () => {
  const r = await get('/');
  const html = await r.text();
  assert(r.status === 200 && html.includes('<div id="root">'), `HTTP ${r.status}, no SPA root`);
  assert((r.headers.get('content-security-policy') ?? '').includes("default-src 'self'"), 'no CSP');
  asset = /src="(\/assets\/[^"]+\.js)"/.exec(html)?.[1] ?? '';
  assert(asset, 'index references no /assets/*.js bundle');
});

await check('bundle, service worker, manifest, deep link', async () => {
  for (const p of [asset, '/registerSW.js', '/sw.js']) {
    const r = await get(p);
    assert(r.status === 200 && (r.headers.get('content-type') ?? '').includes('javascript'), `${p}: HTTP ${r.status}`);
  }
  const m = await get('/manifest.webmanifest');
  assert(m.status === 200 && (await m.text()).includes('"name":"StorAlex"'), 'manifest');
  const deep = await get('/items/1');
  assert(deep.status === 200 && (await deep.text()).includes('<div id="root">'), 'SPA deep link');
});

await check('auth gate: /api and /media need a session', async () => {
  for (const p of ['/api/me', '/api/items', '/api/places', '/media/1']) {
    const r = await get(p);
    assert(r.status === 401, `${p}: HTTP ${r.status}`);
  }
  const s = await get('/api/setup-needed');
  const body = (await s.json()) as { needed?: unknown };
  assert(s.status === 200 && typeof body.needed === 'boolean', 'setup-needed');
  return `setup needed: ${String(body.needed)}`;
});

await check('dotfiles and sources are not served', async () => {
  for (const p of ['/.env', '/package.json', '/dist/server/index.js']) {
    const r = await get(p);
    const t = await r.text();
    assert(!t.includes('"dependencies"') && !t.includes('APP_PEPPER') && !t.includes('buildApp'), `${p} leaked`);
  }
});

await check('argon2id (native) hashes and verifies in memory', async () => {
  const h = await hash('post-deploy-probe', { memoryCost: 19456, timeCost: 2, parallelism: 1 });
  assert(h.startsWith('$argon2id$') && (await verify(h, 'post-deploy-probe')), 'argon2 round trip');
});

await check('sharp (native) re-encodes an image in memory', async () => {
  const png = await sharp({ create: { width: 4, height: 4, channels: 3, background: '#808080' } }).png().toBuffer();
  const webp = await sharp(png).webp().toBuffer();
  const meta = await sharp(webp).metadata();
  assert(meta.format === 'webp' && meta.width === 4, 'sharp round trip');
});

console.log(failed ? `POST-DEPLOY FAILED (${failed})` : 'POST-DEPLOY OK');
process.exit(failed ? 1 : 0);
