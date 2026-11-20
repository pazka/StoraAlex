# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What StorAlex is

Self-hosted personal storage-unit inventory. Pre-print QR labels, scan objects and storage places in/out with a phone/tablet, track movements, tag items for events. SQLite is the source of truth; a Google Sheet is a live read-only mirror (deferred). Ships as one self-contained Docker image for a VPS behind the owner's TLS reverse proxy.

**[SPEC.md](./SPEC.md)** is the full design, **[AGENTS.md](./AGENTS.md)** the enforced build contract, **[docs/OWNER-NOTES.md](./docs/OWNER-NOTES.md)** the decisions log + open questions. AGENTS.md rules are enforced, not advisory.

## Status

Milestones **M0–M8** are implemented, tested, and verified end-to-end in a browser — including **M7** (read-only Google Sheet mirror: `src/server/lib/sheet.ts` pushes Places/Items/Tags to a Sheet, debounced on change via an onResponse hook + periodic reconcile; configured by `SHEET_ID` + `GOOGLE_SERVICE_ACCOUNT_JSON`). Sheet failures are isolated (the app never breaks). Open questions tracked in docs/OWNER-NOTES.md.

## Commands

```bash
npm ci                  # install from the committed lockfile (.npmrc keeps scripts disabled)
npm run dev             # Fastify API (:8080) + Vite dev server (:5173) together
npm run build           # build:client (vite -> dist/client) + build:server (tsc -> dist/server)
npm start               # run the compiled app, serving API + PWA on :8080
npm test                # vitest (test/*.test.ts); `npx vitest run test/api.test.ts` for one file
npm run typecheck       # tsc for server (tsconfig.server.json) and client (tsconfig.client.json)
npm run seed            # create the first admin from SEED_ADMIN_* if no users exist
npm audit               # run after any dependency change
bash scripts/smoke.sh <image>  # container smoke against a built image (see TESTING.md)
```

Environment: Windows 11, **PowerShell** (no WSL/Python/cargo). Node 24, npm 11. Docker Desktop is installed; run tests and the image smoke in containers per TESTING.md. Prefix noisy commands with `rtk` to cut tokens.

## Architecture

Single Node process (`src/server/index.ts`) serves the JSON API, the built PWA, and authenticated media from one port. TypeScript end to end, ESM, **NodeNext module resolution — relative imports must use `.js` extensions** even though the files are `.ts`.

- **`src/server/`** — Fastify backend.
  - `app.ts` — the app factory: registers helmet/cookie/rate-limit/multipart, the **URL-prefix auth gate** (`needsAuth()` — every `/api/*` except `auth/login|logout` and every `/media/*` needs a valid session), and all route plugins; serves `dist/client` as a SPA in production.
  - `config.ts` — env parsing; requires `APP_PEPPER`/`SESSION_KEY` in production, ephemeral fallback in dev/test.
  - `db/index.ts` — opens `node:sqlite`, runs SQL migrations on boot, exposes a **re-entrant** `tx()`.
  - `db/repos.ts` — all data access, one factory `createRepos(db)`; every query is parameterized (helpers `all`/`get`/`run`).
  - `db/migrations/*.sql` — schema; copied into `dist/` by the build.
  - `auth/` — argon2id+pepper (`password.ts`), session token hashing (`session.ts`).
  - `routes/` — one plugin per area (auth incl. first-run `/api/auth/setup`, users, items, places, codes, tags, movements, media, sheet); `FastifyPluginAsyncTypebox`.
  - `schemas.ts` — TypeBox request schemas (`additionalProperties:false` → unknown fields are rejected).
  - `lib/` — `images.ts` (sharp re-encode/EXIF-strip), `pdf.ts` (QR label sheet), `sheet.ts` (M7 read-only Google Sheet mirror; off unless `SHEET_ID` and `GOOGLE_SERVICE_ACCOUNT_JSON` or `_B64` are set).
- **`src/client/`** — React + Vite PWA. `lib/api.ts` (fetch wrapper), `lib/auth.tsx` (session context), `lib/queries.ts` (TanStack Query hooks), `components/` (Layout, Scanner, PlacePicker, ui), `pages/` (Scan/Items/Places/Tags/Labels/…). Routing via react-router; QR scan via `@zxing/browser` with a manual-entry fallback.
- **`src/shared/`** — types and code-ID helpers (`ids.ts`) used by both sides.

## Key implementation decisions (don't "fix" these without reading why)

- **`node:sqlite`, not better-sqlite3**; **`@node-rs/argon2`, not argon2**; **sharp 0.35** — all chosen because `.npmrc` enforces `ignore-scripts=true`, which blocks packages needing an install/build script. These three install via prebuilt binaries (built-in / optional-dep packages) with no scripts. Still argon2id per SPEC. See docs/OWNER-NOTES.md §1–3.
- **Sessions are server-side** (`session` table), cookie holds a random token, DB stores its SHA-256. Cookie is `httpOnly` + signed + `SameSite=Strict`; `Secure` only in production (so dev login works over http://localhost).
- **`tx()` is re-entrant** (depth-guarded WeakMap) because code allocation runs its own transaction inside item/place creation transactions.
- **ajv `removeAdditional:false`** is set in `app.ts` so `additionalProperties:false` rejects unknown fields (SPEC §7.4) instead of stripping them.

## Security acceptance criteria (SPEC §7 — must hold)

Parameterized SQL only · TypeBox validation on every route, unknown fields rejected · argon2id + server-side pepper (env only) · auth on every `/api/*` (except login/logout) and `/media/*` · httpOnly+Secure+SameSite=Strict signed session cookie with server-side revocation · uploads validated by magic bytes (sharp), size-capped, re-encoded, EXIF-stripped, random filenames, path-traversal-guarded serving · helmet CSP (prod), no inline scripts · rate-limited login + resolve · no LLM in the app.

## Supply-chain rules (AGENTS.md — NON-NEGOTIABLE)

`.npmrc` ships `ignore-scripts=true` + `save-exact=true` — **keep both**. Vet any new dependency (downloads, last publish, CVEs, and whether it installs under `ignore-scripts`) before adding. Prefer prebuilt-binary packages. If a dep genuinely needs a build step, **stop and flag the owner** — don't enable scripts. Pin exact versions, commit `package-lock.json`, re-run `npm audit` after changes. npm only.

## Working style

Surgical changes; TDD for security-critical flows (tests in `test/`); Conventional Commits; **don't push or open PRs unless asked**. DoD per milestone: builds clean · tests pass · `npm audit` clean · security criteria met · Docker image still builds · README/OWNER-NOTES updated if behavior changed.

## Agent system: QA gate, journal, "what happened to X"
**Before any work in this repo, whatever the request:** read the hub `pazka/hosh-management`:
`AGENTS.md` (how the hosh.it agents and the owner work together), `README.md` (every app, site, repo and
journal), `roles/` (the full procedure of each agent: QA, Security, Developer, DevOps, dependency updates).
`gh api repos/pazka/hosh-management/contents/AGENTS.md -H "Accept: application/vnd.github.raw"`
(same for `README.md`, `roles/README.md`, `roles/qa.md`...). Those rules apply here; this file adds the
repo's own.

Canonical rules: `AGENTS.md` in the private hub `pazka/hosh-management`
(`gh api repos/pazka/hosh-management/contents/AGENTS.md -H "Accept: application/vnd.github.raw"`).
Summary, binding for every agent that works in this repo:
- **Nothing is merged without the independent QA agent.** Work on `agent/<topic>-<yyyymmdd>`, get CI
  green, write in the PR body what changed, which use cases it touches and how it was tested, then add
  the label `qa:requested`. Merge only when the PR has `qa:approved` AND a comment
  `QA-VERDICT: APPROVED sha=<current head sha>`. On `qa:changes-requested`: fix on the same branch,
  answer each finding, ask again; QA re-tests the whole PR. Never approve your own PR. After QA's
  approval the agent that opened the PR merges it: this replaces "the owner merges" and "merge when
  CI is green" wherever this file still says so.
- **Owner fast lane**: when the owner asks for a feature in a session he is in, do it end to end in
  that session (discuss, develop, QA by a fresh independent QA subagent or a QA routine run now, merge,
  release, deploy, show the live URL). Rules: AGENTS.md section 2b. The session that wrote the code never
  writes the verdict.
- **QA owns the tests and the visual regression**: every use case a user can reach (listed in
  `TESTING.md`), screenshots at 1400 / 1024 / 390 px, baselines in the repo. A wanted visual change
  must be announced in the PR. Never weaken a test or a gate to get green.
- A NEW third-party dependency always needs the owner: open an issue in `pazka/hosh-management`
  labelled `ready-for-human` (that label is the list of places where the owner is needed).
- Release = Actions → release with `version=vX.Y.Z` on the default branch. Never push a git tag.
- **Journal**: after each event (PR ready, QA verdict, merge, release, deploy, rollback, incident,
  blocker) add one comment to this project's journal, `pazka/hosh-management#18`.
- **When the owner asks "what happened to X"** (this app, another one, or the server): open the index
  in `pazka/hosh-management` `README.md`, read the last comments of X's journal issue
  (`gh issue view <n> -R pazka/hosh-management --comments`), then the open `ready-for-human` issues,
  then PRs / Actions runs if needed. Server facts you cannot see: ask the Box agent (mailbox from a
  laptop session, or an issue labelled `box-question`). Answer with: what happened (dated), the state
  now, where the owner is needed.
- Online checks use only the URLs in `pazka/hosh-management` `uptime/checks.json`.
