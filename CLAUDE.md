# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What StorAlex is

Self-hosted personal storage-unit inventory. Pre-print QR labels, scan objects and storage places in/out with a phone/tablet, track movements, tag items for events. SQLite is the source of truth; a Google Sheet is a live read-only mirror (deferred). Ships as one self-contained Docker image for a VPS behind the owner's TLS reverse proxy.

**[SPEC.md](./SPEC.md)** is the full design, **[AGENTS.md](./AGENTS.md)** the enforced build contract, **[docs/OWNER-NOTES.md](./docs/OWNER-NOTES.md)** the decisions log + open questions. AGENTS.md rules are enforced, not advisory.

## Status

Milestones **M0–M6 + M8** are implemented, tested, and verified end-to-end in a browser. **M7 (Google Sheet mirror) is deferred** — endpoints exist in `src/server/routes/sheet.ts` but return 501 until a Google service account is configured. The deferral and the open questions are tracked in docs/OWNER-NOTES.md.

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
```

Environment: Windows 11, **PowerShell** (no WSL/Python/cargo). Node 24, npm 11. Docker is **not** installed locally (the image is built on the VPS). Prefix noisy commands with `rtk` to cut tokens.

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
  - `lib/` — `images.ts` (sharp re-encode/EXIF-strip), `pdf.ts` (QR label sheet), `sheet.ts` (M7 stub).
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
