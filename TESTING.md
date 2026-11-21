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
| `container smoke` | builds the Dockerfile, runs `scripts/check-node-version.sh` on it (and asserts the check rejects unpatched `node:24.21.0-slim`), then `scripts/smoke.sh`, `scripts/compose-smoke.sh legacy`, `scripts/register-check.sh` (+ a rejected non-read-only compose), `compose-smoke.sh template` and `cutover` |
| `visual regression` | builds the Dockerfile, runs `visual/run.sh` (section "Visual use cases" below), uploads shots, diffs and `report.json` as the artifact `visual-<sha>` |

`scripts/check-node-version.sh <image>` fails if the image's Node is EOL or below the
patched minimum of its line (CVE-2026-111497, pazka/hosh-management#5). It also runs in
`release.yml` and `build-scan-push.yml` before any push. Node 20 is EOL and only
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
- **Logging standard** (hosh-management AGENTS.md §11, `test/logging.test.ts`, code in
  `src/server/lib/log.ts`) — one JSON line per event on stdout (`ts`, `level`, `service`,
  `version`, `event`, `msg`); a real server process prints `startup` (version, port, data dir
  writable, config names without values) and `shutdown` on SIGTERM, nothing on stderr; a 5xx
  from a thrown error is one `request_failed` error line with the route template and `err`
  (type, message, stack), never the raw path or query; a 5xx the app answers on purpose (502 when
  Google refuses a Sheet export) is a `request_5xx` warn; a refused login is one `auth_refused` warn line without the
  username or password; other answers and `/healthz` stay at debug; a request slower than 1 s is
  a `request_slow` warn; `X-Request-Id` is echoed (plain token, at most 64 chars) or generated on
  every answer, the auth gate's 401 included; e-mail addresses never reach `err`. Fastify's own
  logger is off (it wrote every request with its raw URL and the client IP). `LOG_LEVEL`
  (or `APP_LOG_LEVEL`), default `info`. The smokes and the visual harness fail on any
  `"level":"error"` line (and still on pino's 50/60).
  A `NODE_ENV=production` server process (the one where Fastify's logger used to be on) answers a
  request with a query string and a refused login: every stdout line is ours, with no path, query,
  IP or e-mail. Background jobs (`lib/jobs.ts` session prune, `lib/sheet.ts` `sync()` for boot,
  reconcile and change) write a start line (debug) and an end line with `dur_ms` and counts
  (`deleted`; `rows` per tab), or a `*_failed` warn with `err`; the Sheet tests use a fake client
  (`createSheetMirror(..., makeClient)`), never Google. The hourly prune timer itself is not
  driven by a test (the job it calls is). `config_ephemeral_secret` names the variable, never a value.
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

`scripts/compose-smoke.sh template <image>`: `docker-compose.example.yml` as hosh-deploy runs
it (`storalex.env` from `.env.example`, uid 10001, read-only rootfs, PORT 8000 on
`127.0.0.1:9138`, service account as `GOOGLE_SERVICE_ACCOUNT_JSON_B64`): same checks, plus
the box's `register` validation, `/healthz` capability fields, rootfs not writable, and
`POST_DEPLOY` from `deploy/hosh-deploy.conf` run like hosh-deploy (`compose exec`, argv).

`scripts/compose-smoke.sh cutover <image>`: DEPLOY.md §1b end to end, its two marked shell
blocks executed verbatim: secrets moved from the legacy container (names printed, values
not), legacy stopped, volume copied and chowned to 10001 (sha256 identical file by file),
a second copy refused, template up on the copy (same login, item, photo bytes), then
rollback: legacy up again on its untouched volume.

## Visual use cases (visual regression, hosh-management AGENTS.md §3)

`bash visual/run.sh storalex:smoke` (CI job `visual regression`; `--update` rewrites the baselines, QA only):
the built image runs as `docker-compose.example.yml` does (uid 10001, read-only rootfs, tmpfs /tmp, cap_drop ALL,
no-new-privileges, pids/memory limits, `PORT=8000`, `NODE_ENV=production`, `TRUST_PROXY` of `.env.example`,
throwaway fake secrets, Sheet mirror unconfigured) on a **fresh volume**, published on 127.0.0.1 only. The run
checks uid 10001, a read-only rootfs and a fresh instance, then `visual/shoot.mjs` runs with the **image's own
node** (same hardening, no package): it drives two headless Chromes of the runner (mouse for 1400 / 1024, touch
for 390) over the DevTools protocol (`visual/cdp.mjs`, Node built-ins only, as pazka/hosh-hub `tools/interact.mjs`).
Pages are opened at `http://localhost:<port>` (Chrome treats localhost as secure, so the production
`__Host-storalex_sid` Secure cookie works); every other host name resolves to nothing.

Data, all made through the API in a fixed order (`visual/cases.mjs` `SEED`):
- phase **fresh**: nothing; then `POST /api/auth/setup` makes **alex** (his session cookie is given to the
  logged-in cases);
- phase **empty**: alex only;
- phase **seeded**: user **marie** (never logged in); tags *Expo Lyon 2026* (event), *Fragile* (flag), *Loaned*
  (other); 2 photos (PNG made with zlib, re-encoded by sharp); places *Unit 12* (PLC-000001, photo, info, tag
  Expo) › *Shelf 1*, *Shelf 2*; *Garage* (tag Loaned); *Old cabinet* (archived); objects *Camera tripod*
  (OBJ-000001, Shelf 1, photo, €129.99, notes, tags Expo + Fragile), *Canvas 80x60* (Shelf 1, Expo),
  *Projector* (Unit 12, €450), *Folding table* (out of storage), *Desk lamp* (Garage), *Broken chair*
  (archived); 2 blank object labels printed (OBJ-000007, OBJ-000008). Each object is finished in its own
  second (the list is ordered by `updated_at`, 1 s resolution) and the list is read back and checked;
- phase **mutating** (last): cases that change data, each resetting what it changes before every width.

Determinism: the page clock starts at 2026-01-01 12:00 UTC and `Math.random` is seeded; no camera (getUserMedia
rejects, so the scanner shows its **manual-entry fallback**, as on a device without a camera); no service worker
(each shot is a first visit); animations, transitions and caret off; timezone Europe/Paris, locale en-US;
viewport height 900 (phone 844), full-page shots (the viewport grows to the page height so the fixed bottom bar
stays at the bottom), modals shot as the screen shows them. The server stamps history and last login with
SQLite `datetime('now')` and the image has no fake clock, so every `YYYY-MM-DD HH:MM:SS` text is replaced by
`2026-01-01 12:00:00` just before the shot. Each shot uses its own `X-Forwarded-For` address (trusted from the
docker network, as on the box) so the app's per-IP rate limits, unchanged, are never reached by ~140 page loads.
A shot fails on a page exception or `alert()/confirm()`, a page that never gets ready, a missing baseline, a
size change or more than 0.1 % of pixels differing by more than 24 on a channel; the run fails too if the app
logs an error-level line. Shots, diffs (`diff/`), `report.json` (requests of every shot, Chrome version) and the
app log are in the CI artifact `visual-<sha>`.

Every case is shot at **1400, 1024 and 390 px** (`visual/baseline/<id>-<width>.png`). The bottom navigation
(Scan, Items, Places, Tags, Labels) is on every logged-in page at every width: the app has no other menu.

| id | page / state | steps |
|---|---|---|
| S1-first-run-setup | fresh instance: any URL lands on `/login` with "Welcome — create the first account", "Create account" | open `/` |
| E1-items-empty | Objects, no object: "No objects yet…" | alex, `/items` |
| E2-places-empty | Places, none: "No places yet…" | alex, `/places` |
| E3-tags-empty | Tags: the new-tag form, no tag list | alex, `/tags` |
| E4-history-empty | History: "No history yet." | alex, `/history` |
| E5-archive-empty | Archive: "Nothing archived." | alex, `/archive` |
| L1-login | login form (instance set up), logged out | `/login` |
| L2-login-wrong-password | a page needing a session sends to `/login`; wrong password → "invalid credentials" | `/items`, type alex + a wrong password, Sign in |
| X1-server-unreachable | server unreachable (every `/api`, `/media` request fails): the login form, no message | alex, `/`, API down |
| SC1-scan-home | Scan (home): manual code entry ("No camera available"), Pick place / Take out, empty preview, CONFIRM / CANCEL disabled | alex, `/` |
| SC2-scan-object-then-place | "1 object → Garage", "Camera tripod", CONFIRM enabled | enter OBJ-000001, then PLC-000004 |
| SC3-scan-unknown-code | "Unknown code OBJ-999999" | enter OBJ-999999 |
| SC4-scan-take-out | "1 object → out of storage", Take out highlighted | enter OBJ-000003, click Take out |
| SC5-scan-pick-place | modal "Destination place": search + 4 places (archived one hidden) | click Pick place |
| SC6-scan-blank-label | a blank label opens New object: "Label OBJ-000007 will be attached." | enter OBJ-000007 |
| I1-items | Objects: 5 objects (newest first), photo / placeholder, code, in storage / out | `/items` |
| I2-items-search | search "ca": Canvas 80x60, Camera tripod | `/items?q=ca` |
| I3-items-out | filter Out: Folding table | `/items?status=out` |
| I4-items-by-tag | "Filtered by tag Expo Lyon 2026" + clear, 2 objects | `/items?tag=1` (Tags → Objects) |
| I5-items-select | select mode: checkboxes, Projector + Desk lamp ticked, bar "2 selected · Move to… · Take out" | click Select, tick 2 |
| I6-items-no-match | search without result: "No objects yet…" (pinned wording) | `/items?q=zzz` |
| D1-item-detail | Camera tripod: photo, code, in storage, price, notes, location Unit 12 › Shelf 1, Move to… / Take out, 2 tags, Edit / History, Archive | `/items/1` |
| D2-item-out-of-storage | Folding table: out, location —, "Place in storage…", "No tags." | `/items/4` |
| D3-item-add-tag | the available tags "+ Fragile", "+ Loaned" | `/items/2`, click + Tag |
| D4-item-archived | Broken chair: "Archived. Restore it, or delete it permanently." | `/items/6` |
| D5-item-not-found | an object id that does not exist: the error message | `/items/999` |
| F1-item-new | New object: "A new code will be allocated…", Scan label, name, photo, location Choose, price, notes | `/items/new` |
| F2-item-edit | Edit object: fields filled, photo, Replace / Remove | `/items/1/edit` |
| F3-item-scan-label | modal "Scan this object's label" with the manual-entry fallback | `/items/new`, click Scan label |
| P1-places | Places: Garage, Unit 12 (top level only) | `/places` |
| P2-place-detail | Unit 12: photo, info, Move under…, tag, 2 nested places, 1 object, Edit place, Archive | `/places/1` |
| P3-place-nested | Shelf 1: "Inside: Unit 12", Move to top level, no nested place, 2 objects | `/places/2` |
| P4-place-archived | Old cabinet: archived card | `/places/5` |
| P5-place-new | New place form | `/places/new` |
| P6-place-edit | Edit place: Unit 12 filled | `/places/1/edit` |
| P7-places-by-tag | "Places tagged Expo Lyon 2026" + clear: Unit 12 | `/places?tag=1` (Tags → Places) |
| T1-tags | Tags: form + groups Events / Flags / Other with colour dots and Objects · Places links | `/tags` |
| LB1-labels | Print labels: type Object, count 24, "Generate 24 object labels (PDF)" | `/labels` |
| LB2-labels-place | type Place selected: "Generate 24 place labels (PDF)" | `/labels`, click Place (PLC-…) |
| H1-history | History: every movement, newest first (timestamps normalised) | `/history` |
| H2-history-item | History of Camera tripod: "item #1", ‹ Back | `/history?entity_type=item&entity_id=1` (object → History) |
| A1-admin | Admin: Excel export / import, Google Sheet "Not configured.", links Archive and Users | `/admin` (header 👤 alex) |
| A2-archive | Archive: Old cabinet and Broken chair with Restore / Delete | `/archive` |
| U1-users | Users: add form, alex "(you)", marie "last login: never" | `/users` |
| U2-users-password | the new-password field under marie | `/users`, click marie's Password |
| M1-scan-confirm-move | after CONFIRM: "✓ Moved 1 object to Garage." (Folding table put back out first) | enter OBJ-000004, PLC-000004, CONFIRM |

Not shot (not a page state, or not reachable without a real device): the label PDF itself (it opens in a new tab;
its content is tested in `test/` and `scripts/smoke.sh`), the Excel file, a live camera stream, the browser's own
`confirm()` dialogs of Delete (the harness fails on any dialog), the "Uploading…/Saving…" instants.

What the pictures show today, pinned on purpose (not fixed by the harness, production code unchanged):
- I6: a search or filter without result says "No objects yet. Scan a blank label or tap “New”.", the wording
  of an empty inventory.
- X1: when the server is unreachable the app shows the login form with no message (`/api/me` fails, the
  session is treated as missing), so a logged-in user is told nothing about the outage.
- H1 / H2: history lines name places and objects by number ("place #4", "item #1"), not by name.
- D4: an archived object keeps its location and shows "in storage", "Move to…" and "Take out" above the
  archived card (Broken chair, archived while in Garage).
- Every logged-in page: the runner's fonts have no glyph for the Scan icon `⌖` of the bottom navigation, so it
  is drawn as an empty box (same on every run; a phone or desktop with other fonts draws the symbol).
- Baselines are made by the runner's Chrome (`visual/baseline/chrome.txt`); a local Chrome with other fonts
  differs. New baselines come from the CI artifact or the CI log (`visual/from-log.mjs`).

## Deliberately not covered

- The React PWA in a browser beyond what it shows: no browser test runner package (a new dependency is an
  owner decision). The visual harness below drives the runner's Chrome with Node built-ins and pins every
  page and state a user can reach; behaviour behind the pictures is covered by the API tests.
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

- `.github/workflows/deploy.yml` (now `build-scan-push.yml`) contained a CP-1252 byte (invalid UTF-8); it was
  replaced by an ASCII hyphen so Dependabot can parse and bump it again.
