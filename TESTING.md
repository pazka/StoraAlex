# Testing

The suite is a **safety net for upgrades** (Node majors, native deps, base image,
GitHub Actions): it pins what the app does today so a Dependabot PR can be merged
on a green CI run alone.

## Run it

Everything runs in containers — nothing from `node_modules` executes on the host.

```bash
# unit + characterization tests on the Dockerfile's Node major (26)
docker run --rm -v "$PWD":/app -v storalex_nm26:/app/node_modules -w /app node:26-slim \
  sh -c "npm ci && npm run typecheck && npm test"

# container smoke: build the real image, run it hardened, hit real endpoints
docker build -t storalex:smoke . && bash scripts/check-node-version.sh storalex:smoke \
  && bash scripts/smoke.sh storalex:smoke

# try another base image before Dependabot's PR lands (edit the FROM tag+digest)
sed 's|^FROM node:[^ ]*|FROM node:<new-tag>|' Dockerfile | docker build -f - -t storalex:next . \
  && bash scripts/smoke.sh storalex:next
```

On Windows Git Bash prefix the `docker run` with `MSYS_NO_PATHCONV=1` and use
`"$(cygpath -w "$PWD")"` for the bind mount. `scripts/smoke.sh` handles this itself.

Outside Docker, `npm ci && npm test` works too (`.npmrc` keeps install scripts off).

## CI (`.github/workflows/ci.yml`)

Runs on every pull request, on `main`, and on `agent/**` branches.

| job | what |
|---|---|
| `test (node 26)` | `npm ci`, typecheck, vitest, build — inside `node:26-slim`, same family as the Dockerfile |
| `container smoke` | builds the Dockerfile, runs `scripts/check-node-version.sh` on it (and asserts the check rejects unpatched `node:24.21.0-slim`), then `scripts/smoke.sh`, then `scripts/compose-smoke.sh legacy` |

`scripts/check-node-version.sh <image>` fails if the image's Node is EOL or below the
patched minimum of its line (CVE-2026-111497, pazka/hosh-management#5). It also runs in
`release.yml` and `deploy.yml` (build-scan-push) before any push. Node 20 is EOL and only
LTS lines are allowed; when the Dockerfile moves to a new LTS major, move the matrix with it.

## What is covered

Existing behaviour tests (`api`, `data`, `images`, `users`) plus `test/upgrade.test.ts`:

- **Auth gate** — every registered `/api/*` and `/media/*` route returns 401 without a
  session (route list is explicit: a new route must be added there); forged cookies
  rejected; public routes stay public.
- **node:sqlite** — all 5 migrations apply on a fresh DB, schema snapshot
  (`test/__snapshots__/`), re-open is idempotent, WAL + foreign keys on, re-entrant
  `tx()` rollback, async callback refused, movement log triggers present.
- **argon2id** — a hash produced before the upgrade still verifies (otherwise every
  user is locked out); pinned cost parameters; malformed hash → false.
- **sharp via HTTP** — JPEG with EXIF uploaded through `/api/media` is stored as an
  EXIF-free webp with a random name and served back; disguised non-image → 400.
- **pdf-lib/qrcode** — label sheet is a valid A4 PDF, 24 labels/page, limits enforced.
- **Production mode** — refuses to boot without secrets, `trustProxy` = 1 hop
  (and `TRUST_PROXY=<n>` really makes `req.ip` the client n hops back),
  `__Host-` cookie with HttpOnly/Secure/SameSite=Strict/no Domain, signed; CSP header.
- **Sheet mirror unconfigured** — boots, status 200, export 501, stays healthy.

`scripts/smoke.sh` (against the built image): read-only rootfs + `cap_drop ALL` +
`no-new-privileges`, non-root, HEALTHCHECK healthy, SPA served (hashed bundle,
`registerSW.js`, `sw.js` precache, manifest, deep-link fallback, no path
traversal out of `dist/client`), auth gate, first-run
setup → hardened cookie, login, DB file on `/data`, PDF, real PNG upload through
sharp, non-image rejected, no error-level logs.

`scripts/compose-smoke.sh legacy <image>`: the box's hand-made compose today
(`/root/hosh-deploy/storalex`), verbatim except the image: image user (uid 1000), port 8080
on `127.0.0.1:8090`, `.env`, named volume `storalex_storalex-data`, Google service-account
JSON bind-mounted read-only at `/run/secrets/google-sa.json`. Proves: HEALTHCHECK healthy,
`/healthz`, SPA, auth gate, first-run setup, place + item + photo written, label PDF, the
Sheet mirror finds and parses its credentials (fake key: signing fails locally, nothing is
sent to Google), then `compose down` + `up` and the same password, item, location and photo
bytes come back, new writes work, no error-level logs.

## Deliberately not covered

- The React PWA in a browser (no browser test runner; adding one needs a new
  dependency — owner decision). The build step does prove it compiles.
- Google Sheet sync against the real API (needs credentials; only the
  unconfigured path is tested).
- Excel import of real-world files beyond the round-trip test.
- Rate-limit thresholds (time-window based, slow and flaky in CI).

## Upgrades this suite has checked

- **Node 24 → 26** (Dependabot #4): tests 97/97 and container smoke green on
  `node:26-slim` (26.12.0) on 2026-10-19 → **applied**: the Dockerfile is on `node:26-slim` (supersedes #4).
- **Node 26.13.0, pinned by digest** (2026-11-06, pazka/hosh-management#5, CVE-2026-111497
  fixed in 26.12.1): Dockerfile `FROM node:26.13.0-slim@sha256:5adad64f…`, CI matrix 26 only
  (Node 24 dropped), Node version guardrail added to CI + release + build-scan-push.
- **npm deps, 2026-10-19** (Dependabot #10–#14, branch `agent/deps-oct2026`):
  minor/patch group (fastify 5.8 → 5.12 …), `@fastify/static` 10, `vite-plugin-pwa` 2,
  `typescript` 7, `vitest` 5 → tests 98/98 on node 24 + 26, smoke green.
  fastify 5.12 stopped honouring a numeric `trustProxy` (it now trusts no hop):
  `app.ts` maps `TRUST_PROXY=<n>` to the equivalent hop-count trust function, so
  behaviour is unchanged. TS 7 emits identical `dist/server` JS; PWA 2 builds a
  byte-identical `dist/client`. `npm audit` still lists transitive advisories
  (`@fastify/busboy`, `fast-uri`, `find-my-way`, `qs`, dev-only tooling) that
  `npm audit fix` resolves within existing ranges — left for a separate change.
- Would catch: `node:sqlite` API/behaviour changes, argon2 binary or hash format
  changes, sharp prebuilt binary missing for the new base, pdf-lib output breakage,
  fastify/cookie attribute changes, ajv starting to strip instead of reject.

## Known quirks (not changed)

- `.github/workflows/deploy.yml` contained a CP-1252 byte (invalid UTF-8); it was
  replaced by an ASCII hyphen so Dependabot can parse and bump it again.
