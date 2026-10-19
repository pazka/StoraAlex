# Testing

The suite is a **safety net for upgrades** (Node majors, native deps, base image,
GitHub Actions): it pins what the app does today so a Dependabot PR can be merged
on a green CI run alone.

## Run it

Everything runs in containers — nothing from `node_modules` executes on the host.

```bash
# unit + characterization tests on a given Node major (24 = current, 26 = next)
docker run --rm -v "$PWD":/app -v storalex_nm24:/app/node_modules -w /app node:24-slim \
  sh -c "npm ci && npm run typecheck && npm test"

# container smoke: build the real image, run it hardened, hit real endpoints
docker build -t storalex:smoke . && bash scripts/smoke.sh storalex:smoke

# try the next base image before Dependabot's PR lands
sed 's/node:24-slim/node:26-slim/g' Dockerfile | docker build -f - -t storalex:next . \
  && bash scripts/smoke.sh storalex:next
```

On Windows Git Bash prefix the `docker run` with `MSYS_NO_PATHCONV=1` and use
`"$(cygpath -w "$PWD")"` for the bind mount. `scripts/smoke.sh` handles this itself.

Outside Docker, `npm ci && npm test` works too (`.npmrc` keeps install scripts off).

## CI (`.github/workflows/ci.yml`)

Runs on every pull request, on `main`, and on `agent/**` branches.

| job | what |
|---|---|
| `test (node 24)` / `test (node 26)` | `npm ci`, typecheck, vitest, build — inside `node:<n>-slim`, same family as the Dockerfile |
| `container smoke` | builds the Dockerfile, runs `scripts/smoke.sh` |

When the Dockerfile moves to a new Node major, move the matrix up with it
(current + next).

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
- **Production mode** — refuses to boot without secrets, `trustProxy` = 1 hop,
  `__Host-` cookie with HttpOnly/Secure/SameSite=Strict/no Domain, signed; CSP header.
- **Sheet mirror unconfigured** — boots, status 200, export 501, stays healthy.

`scripts/smoke.sh` (against the built image): read-only rootfs + `cap_drop ALL` +
`no-new-privileges`, non-root, HEALTHCHECK healthy, SPA served, auth gate, first-run
setup → hardened cookie, login, DB file on `/data`, PDF, real PNG upload through
sharp, non-image rejected, no error-level logs.

## Deliberately not covered

- The React PWA in a browser (no browser test runner; adding one needs a new
  dependency — owner decision). The build step does prove it compiles.
- Google Sheet sync against the real API (needs credentials; only the
  unconfigured path is tested).
- Excel import of real-world files beyond the round-trip test.
- Rate-limit thresholds (time-window based, slow and flaky in CI).

## Upgrades this suite has checked

- **Node 24 → 26** (Dependabot #4): tests 97/97 and container smoke green on
  `node:26-slim` (26.12.0) on 2026-10-19 → safe to merge once CI is green on the PR.
- Would catch: `node:sqlite` API/behaviour changes, argon2 binary or hash format
  changes, sharp prebuilt binary missing for the new base, pdf-lib output breakage,
  fastify/cookie attribute changes, ajv starting to strip instead of reject.

## Known quirks (not changed)

- `.github/workflows/deploy.yml` contained a CP-1252 byte (invalid UTF-8); it was
  replaced by an ASCII hyphen so Dependabot can parse and bump it again.
