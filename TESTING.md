# Testing StorAlex

This suite is a **safety net for upgrades** (Dependabot npm bumps, `node:<major>-slim` base-image bumps, GitHub Action bumps). Most tests are *characterization tests*: they pin what the app does **today** (routes, status codes, response shapes, file formats, DB schema, cookie format), whether or not that behaviour is ideal. A red test after an upgrade means "behaviour changed — look before merging", not necessarily "the upgrade is wrong".

When you change behaviour on purpose, update the pinned expectation in the same commit.

## Running it

```bash
npm ci
npm test                         # all of test/*.test.ts (the boot test skips if dist/ is missing)
npm run build && npm test        # include the compiled-app boot test
npx vitest run test/db.test.ts   # one file
```

`REQUIRE_BUILD=1 npm test` makes a missing `dist/` a failure instead of a skip (CI sets it).

All tests use fake secrets, temp directories and in-memory or temp SQLite files. Nothing reads `.env` (the boot test starts the server from a scratch working directory with an environment built from scratch), and nothing touches the network (the Google Sheets client is mocked).

### Same runtime as production (needs Docker)

The Dockerfile's base image is what matters for Node-major upgrades. To run the suite on a given major exactly like CI does:

```bash
docker run --rm -v "$PWD:/src:ro" node:26-slim bash -c \
  "cp -r /src /w && cd /w && rm -rf node_modules dist && npm ci && npm run build && REQUIRE_BUILD=1 npm test"
```

(PowerShell: replace `"$PWD:/src:ro"` with `"${PWD}:/src:ro"`.)

Container smoke test against a locally built image:

```bash
docker build -t storalex:smoke .
bash test/smoke/container-smoke.sh storalex:smoke
```

## CI (`.github/workflows/deploy.yml`, workflow `build-scan-push`)

Runs on every pull request, on push to `main`, and on manual dispatch.

| Job | What it proves |
| --- | --- |
| `test (node 24)` / `test (node 26)` | Inside `node:<major>-slim` (the Dockerfile's base image family): `npm ci` with scripts disabled, `typecheck`, `build`, full vitest suite incl. the boot test. 24 = current base; 26 = the pending bump. |
| `container smoke` | 1. Runs the whole suite **inside the Dockerfile's own build stage**, so it automatically follows whatever `FROM` line the Dockerfile has. 2. Builds the runtime image and runs `test/smoke/container-smoke.sh`: compose hardening (`--cap-drop ALL`, `no-new-privileges`, non-root, `/data` volume, `TRUST_PROXY=1`, `NODE_ENV=production`), waits for the image's own HEALTHCHECK (only its polling interval is shortened), checks uid 1000 / no effective capabilities / npm absent, hits `/healthz`, `/`, three 401s, setup → `__Host-` cookie flags, `/api/me`, a PNG upload + `/media/1`, a label PDF, scans logs for error/fatal entries and unexpected stderr, and checks `docker stop` exits 0. |
| `build` | Unchanged build → Trivy → push to ghcr, now only after `test` and `smoke` pass, and never on pull requests. |

Manual dispatch has a `tests_only` input (default `false`) to run only `test` + `smoke` without pushing images, e.g. on a feature branch.

`security-autofix.yml` now opens its "CVE remediation" issue only when the **Trivy** step failed. Before, any failed run counted, so a red test would have opened a false CVE issue.

## What is covered

| File | Area | Guards against |
| --- | --- | --- |
| `auth-gate.test.ts` + `routes.ts` | Full route table, pinned via an `onRoute` hook (a test-only wrap of the Fastify factory). Every protected route → 401 `{error:'unauthorized'}`. Unknown `/api/*`, `/media/*` → 401. Unsigned, tampered, unknown, expired and logged-out sessions → 401. Path variants (`//api`, `/API`) never reach a handler. Public routes still answer. | fastify / find-my-way routing or hook-order changes that open a route; @fastify/cookie signing changes. A new route that isn't added to `routes.ts` fails the inventory test. |
| `boot.test.ts` | The **compiled** `dist/server/index.js` as a real process in production mode, over raw HTTP sockets: healthz, DB + migrations created in `DATA_DIR`, the whole pinned route table → 401, raw `..`/`%2e`/`%2f` path variants, SPA + CSP + service worker, first-run setup cookie (`__Host-`, HttpOnly, Secure, SameSite=Strict, signed, no Domain), JSON 404, sharp upload + PDF in the build, JSON info-level logs with no errors and no unexpected stderr, SIGTERM → exit 0, restart on the same data keeps the user and session. Refuses to start without secrets. | Node-major ESM/NodeNext resolution, tsc/vite output, migrations not copied into `dist`, static serving, real-socket path normalisation, startup/shutdown, log noise (e.g. a new runtime warning). |
| `db.test.ts` | Migrations on a fresh DB (names and order), **schema snapshot** (tables, columns, types, defaults, PKs, indexes, triggers, FKs), code-seq seed, on-disk reopen is idempotent, WAL / foreign_keys / busy_timeout, FK and append-only triggers enforced, driver return types, `UNIQUE` error text, `tx()` commit / rollback / re-entrancy / async rejection / `BEGIN IMMEDIATE`. | `node:sqlite` API or behaviour changes in Node majors, bundled SQLite version changes, accidental schema drift from a migration. |
| `password.test.ts` | argon2id v19, `m=19456,t=2,p=1` PHC format, salting, round-trip, wrong password / wrong pepper, unicode, malformed hash → `false`. A **stored fixture hash** (fake pepper and password) still verifies. | @node-rs/argon2 default or parameter changes; prebuilt-binary breakage on a new Node ABI; a change that would lock every existing user out. |
| `media.test.ts` (+ existing `images.test.ts`) | `POST /api/media` end to end: a JPEG with EXIF orientation 6 and a marker string comes back as a rotated WebP with no EXIF, XMP, ICC or marker bytes, a random `[0-9a-f]{32}.webp` name and a matching DB row. PNG accepted regardless of declared type. Identical uploads get different names. A non-image named `.jpg` → 400 and nothing written. SVG → 400. Non-multipart → 400. No file part → 400. Over `MAX_UPLOAD_BYTES` → 413. `GET /media/:id` content type and cache headers, 404 / 400, path-traversal row → 400, missing file → 404. | sharp/libvips upgrades (metadata handling, format detection, SVG support), @fastify/multipart limit and error behaviour. |
| `pdf.test.ts` | `%PDF-` / `%%EOF`, page counts for 1/24/25/49 labels (24 per page), A4 size, exactly one standard Helvetica font, one image per label, a QR (same options as `lib/pdf.ts`) that decodes back to the exact code with the already-installed `@zxing/library`. `/api/codes/print` headers, sequential unassigned codes, count bounds. | pdf-lib and qrcode upgrades that change output or break readability. |
| `validation.test.ts` | Unknown field → 400 `FST_ERR_VALIDATION` "body must NOT have additional properties" on **every** body schema, with no side effect. Unknown query field → 400. Id, pattern, length and enum bounds. `coerceTypes` (`"12.5"` → 12.5, scalar → array), Null-first unions keep `null`. Malformed JSON → 400, >1 MiB → 413, `text/plain` → 400, unknown content type → 415. | fastify / ajv / TypeBox / type-provider changes that flip "reject" into "strip", change coercion, or change error shape. |
| `production.test.ts` | Production cookie: name, attributes, `Max-Age`, **signature format** (`value.base64(HMAC-SHA256)`, so existing sessions survive an upgrade), sha256-only server storage, the dev cookie name is ignored, logout clears with matching attributes and revokes the session. Exact helmet CSP + hardening headers. Dev mode: no `Secure`, no CSP. Config refuses short or missing secrets, plus prod defaults and `TRUST_PROXY` parsing. | @fastify/cookie, @fastify/helmet default changes (helmet merges its own CSP directives; that is pinned). |
| `sheet.test.ts` | No `SHEET_ID` (the default): boots, status shape, export → 501, mutations never schedule or call Google. `SHEET_ID` without credentials is still unconfigured. With a **mocked** client: debounced push after mutations, exact call sequence and tab/header/row layout, which requests schedule, a 403 never breaks the request and shows up in status / 502, 404/401 messages, credentials from a file, a malformed key fails softly. The real `@googleapis/sheets` export shape is checked without network. | @googleapis/sheets API-shape changes; regressions in "sheet failures never break the app". |

`api.test.ts`, `data.test.ts`, `images.test.ts` and `users.test.ts` already existed and are unchanged.

## Deliberately not covered

- **The React PWA UI.** No browser or e2e tests (that would need Playwright as a new dependency). The boot test and smoke test only check that the built shell, CSP and service worker are served. Client-only bumps (react, react-router, @tanstack/react-query, @zxing/browser, vite-plugin-pwa) are covered only by `typecheck` + `build` succeeding.
- **Real Google Sheets I/O**, by design: no outbound network in tests.
- **Rate limits** (login 10 / 15 min, resolve 120/min, global 300/min). Not pinned, because it is slow and stateful. They are configured in route options.
- **Trivy / image CVEs.** These stay with the existing `build` job.
- **The deploy/promote path** (`release.yml`, Dokploy webhook, ghcr tags).
- **Excel import/export beyond the existing round-trip test** (`data.test.ts`).
- **Performance.** Only noted below.
- **Graceful SIGTERM on Windows.** That boot-test case is skipped on `win32` because Node can't deliver SIGTERM there. CI and the image are Linux.

## Known bugs and observations (found while writing this; NOT fixed)

1. **Truncated JPEG upload → HTTP 500 that leaks the libvips message.** A JPEG whose header is valid but whose data is cut off passes `sharp().metadata()`. The `failOn:'error'` re-encode then throws a plain `Error`, not an `ImageError`, so `routes/media.ts` rethrows it. The client gets `500 {"message":"VipsJpeg: premature end of JPEG image", ...}` instead of a 400. No file is left behind. This is pinned in `media.test.ts` ("KNOWN BUG"); update that test when it is fixed.
2. **Label PDF generation is slow at the maximum count.** `POST /api/codes/print` with `count: 200` takes about 6 s on a dev container: the QR PNGs are generated and embedded one after another. Not a correctness issue.
3. **Nested `tx()` joins the outer transaction; it is not a savepoint.** If an inner `tx()` throws and the outer callback *catches* it, the inner writes are **kept** when the outer commits. No current caller does this, but it is a trap. Pinned in `db.test.ts`.
4. **Case and duplicate-slash variants outside `/api` get the SPA shell.** For example `GET /API/items` returns `index.html` (200, HTML) once `dist/client` exists. It is harmless: no data, and the router is case-sensitive. But it is why the gate tests assert "no JSON data" rather than a specific status.
5. **CI hygiene (outside this change):** the existing `build` job in `deploy.yml` and `release.yml` still reference actions by mutable tags (`actions/checkout@v4`, `docker/*@v3/v6`, `aquasecurity/trivy-action@v0.36.0`). Only the actions added here are SHA-pinned.
