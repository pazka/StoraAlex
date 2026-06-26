# StorAlex — build notes for Alexandre

Built in one session while you were away. Everything below is **for your review when you're back**. The app runs locally and is ready to deploy; a few decisions and open questions are collected here so nothing is silently assumed.

## TL;DR

- Milestones **M0–M6 + M8** are done, tested (22 passing tests), and verified end-to-end in a real browser (login → create place → create object → move out → audit history, no console errors).
- **M7 (Google Sheet mirror) is deferred** as you asked — the endpoints exist but return `501` until you set up a Google Cloud project + service account.
- It is **not committed** — per the repo's build rules I don't commit/push without you asking. Review the working tree and commit when happy (`git add -A && git commit`).
- Local login (dev `.env` I generated): **user `alex`, password `storalex-dev-2026`**. Change/remove this before any real use.

## How to see it running

```bash
npm run dev          # http://localhost:5173  (sign in as alex / storalex-dev-2026)
# or the production-style single-port build:
npm run build && npm start   # http://localhost:8080
```

Camera scanning needs a device with a camera + HTTPS (or localhost); on a desktop without a webcam it falls back to a manual code-entry box, which is what you'll see here.

---

## Key decisions I made (and why)

1. **Database: Node's built-in `node:sqlite`, not `better-sqlite3`.**
   Your `.npmrc` enforces `ignore-scripts=true` (non-negotiable per AGENTS.md). `better-sqlite3` needs a lifecycle *install* script to fetch its native binary, which that setting blocks. `node:sqlite` is built into Node 24, needs no native dependency, and SPEC §2 explicitly sanctions it. Trade-off: it's still marked *experimental* in Node 24 (the API we use — `DatabaseSync`, prepared statements, transactions — is stable in practice). If you'd rather use `better-sqlite3`, we'd need to selectively allow its build script — tell me and I'll switch.

2. **Password hashing: `@node-rs/argon2`, not the `argon2` package.**
   Same reason — `@node-rs/argon2` ships prebuilt binaries as ordinary optional-dependency packages (no install script), so it works under `ignore-scripts=true`. It's still **argon2id** (SPEC §7.1). The server-side pepper is applied via argon2's keyed "secret" mode, not string concatenation.

3. **Images: `sharp` 0.35** — also prebuilt-binary optional deps, works without scripts. Confirmed loading at runtime (libvips 8.18.3).

4. **Sessions: `@fastify/cookie` + a server-side `session` table**, not stateless `@fastify/secure-session`. This gives real logout/revocation. The cookie carries a random token; the DB stores only its SHA-256, so a database leak doesn't hand out live sessions.

5. **Validation: TypeBox schemas + `removeAdditional:false`.** Every route validates body/params/query; unknown fields are **rejected** with 400 (not silently stripped).

6. **All 26 dependencies were vetted** (downloads, maintenance, CVEs, and crucially "does it install under `ignore-scripts`") before adding. `npm audit` is clean (0 vulnerabilities). Versions are pinned exactly and the lockfile is committed-ready.

7. **Codes** are predictable + sequential (`OBJ-000123`) via a counter table, allocated inside a transaction so concurrent scans can't collide.

---

## Questions — resolved (2026-06-26)

- **Label stock** → keep the **A4 sheet, 24-up (3×8)** PDF. (Tell me your exact Avery code / label W×H if you later want it tuned.)
- **Users** → **single user** for now. No manage-users UI built; add users via `SEED_ADMIN_*` env or directly in the DB if needed.
- **Taggable places** → **DONE.** Places are now taggable too (apply/remove on a place's page, filter via Tags → *Places*, logged in the audit trail). Migration `003_place_tags.sql`.
- **Reverse proxy** → **nginx.** Full copy-paste server block (TLS, `client_max_body_size 20m`, single-hop matching `TRUST_PROXY=1`) is in the README deploy section.

## Still open (don't block deployment)

- **History retention.** Movement log is append-only and kept **forever** (now DB-enforced). Confirm that's what you want.
- **Google Sheet mirror (M7).** Deferred. When ready: create a Google Cloud project + service account, share the target sheet with the service-account email, set `SHEET_ID` + `GOOGLE_SERVICE_ACCOUNT_JSON`, and I'll wire export/import. Confirm tab naming (one spreadsheet; tabs items / places / movements / codes / tags?).

## Smaller things I deferred (say the word and I'll add them)

- **Bulk scan-to-move** (scan a destination place, then scan many objects to drop them all there) — SPEC calls it a nice-to-have.
- **History shows `place #N`** rather than the place's name (the audit rows store IDs). Easy to resolve to names if you want prettier history.
- **Multiple photos per object** — schema keeps a single primary photo for now (SPEC v1).
- **Client bundle is ~1 MB** (the `@zxing` QR library is heavy). Fine for self-hosting; can be code-split so the scanner loads lazily if you care about first-load size.

## Round 2 — features added (2026-06-26)

All verified end-to-end in the browser.

- **No admin seed.** First run with an empty database shows a centered "create the first account" screen (`/api/auth/setup`, allowed only while zero users exist). After that it's the normal login. The old `SEED_ADMIN_*` env path still works headlessly via `npm run seed` but is no longer used at boot.
- **User management** (`👤 <name>` in the top bar → Users page). Any signed-in user can add users, reset any password, and delete users — except the last remaining one (lockout guard). Deleting a user revokes their sessions.
- **Places lost the unit/shelf/crate "type"** — they're just nestable containers now (one icon, nesting unchanged). Migration `004` drops the column.
- **Bulk move.** Items list → "Select" → tick objects → "Move to…" or "Take out" moves them all at once (each logged in history).
- **Object price** (optional, shown in €). Migration `004` adds the column. *Currency is hardcoded to € — tell me if you want it configurable or a different symbol.*
- **Login page is centered** (both axes).

While doing this I also fixed a latent validation bug: ajv's type coercion was turning a `null` (e.g. "clear the price/photo") into `0`. All nullable fields now reject coercion correctly.

## Round 3 — scan-driven workflows (2026-06-26)

- **Create with a pre-printed label.** The new-object and new-place forms now have a **Scan label** button (opens the camera) so you can attach a label you printed earlier. It only accepts a blank label of the right kind; otherwise a new code is allocated as before. (Scanning a blank label from the Scan tab still jumps straight here with the code pre-filled.)
- **Scan tab is now a move builder** matching your sketch: camera on top, two manual actions (**Pick place**, **Take out**), an action preview, and big **CONFIRM** / **CANCEL** buttons.
  - Scan a **place** → it becomes the destination. Scan **objects** → they queue up. Order doesn't matter (object-first or place-first both work).
  - **Nothing moves until you press CONFIRM.** CANCEL clears the batch.
  - Works for several objects at once (scan, scan, scan → CONFIRM moves them all). "Take out" sets the destination to "out of storage".
- When there's no camera (e.g. desktop), the scanner shows a manual code-entry box so the same flows still work.

All verified end-to-end in the browser (scanned a place + two objects → CONFIRM moved both; scanned a blank label on the create form → object created with that exact code).

## Round 4 — archive, permanent delete, Excel import/export, bright theme (2026-06-26)

- **Bright/light theme** — switched the whole UI to a light, high-contrast palette for a well-lit room.
- **Archive** (objects & places). Archive from the item/place page; archived things disappear from the normal lists and movement is hidden. Restore any time. Migration `005` adds the field (and `archived`/`unarchived` to the history).
- **Permanent delete** — only available *after* archiving (so you can't nuke something by accident). Reachable from the item/place page or the Archive list (👤 → Admin → Archive).
  - **⚠️ Cascade on places:** permanently deleting a place also deletes every nested place **and the objects inside them** (and their codes/tags/photos). The confirm dialog spells this out and reports how many were removed. I took "delete on cascade" literally — if you'd rather a place delete *keep* the objects (just send them "out"), say the word and I'll flip it.
  - The append-only history rows survive deletions (audit trail), they just keep the old ids.
- **Excel export/import** (👤 → Admin → "Data (Excel)").
  - **Export** → one `.xlsx` with **Places / Items / Tags** sheets.
  - **Import** the same template back. Rows are matched by their **QR code**, so you can bulk-edit names/prices/locations/tags in Excel and re-import — it updates existing rows and creates new ones. Parents/locations reference other rows by code (`parent_code`, `place_code`); tags are comma-separated names. Import runs in one transaction and returns a summary (created/updated counts + any skipped rows).
  - Library: `exceljs` (pure JS, no install scripts). It pulled a stale transitive `uuid` with a moderate advisory — pinned via an override to the patched `uuid@14`, so `npm audit` is **clean (0 vulnerabilities)**.

All verified end-to-end in the browser and with 36 passing tests.

## Security review (multi-agent adversarial pass)

I ran an 8-dimension adversarial security review (auth/session, SQL injection, input validation, uploads, headers/CSP, secrets/config, supply-chain/Docker, business-logic) and verified every finding against the actual code. **No critical or high issues. Zero SQL injection** (all queries parameterized). 20 lower-severity findings were confirmed; I fixed the meaningful ones:

**Fixed**
- **Rate-limit bypass via `X-Forwarded-For` spoofing** — `trustProxy` is now a hop count (default `1` in prod), not blanket-`true`, so `req.ip` can't be spoofed to mint fresh login-throttle buckets.
- **Decompression-bomb OOM** — image decode now capped at 50 MP (oversized → clean 400) so a tiny file can't blow up to a ~1 GB bitmap.
- **Sequence-poisoning DoS** — typing a code in the reserved `OBJ-/PLC-` format is now rejected (it could otherwise wedge code allocation with repeated 500s).
- **Audit-log pollution** — a no-op PATCH no longer writes a phantom "edited" movement.
- **`__Host-` session cookie in production** — blocks a sibling subdomain (you're on shared `hosh.it`) from injecting/overwriting the session cookie. Verified: `__Host-storalex_sid; Path=/; HttpOnly; Secure; SameSite=Strict`.
- **Append-only audit log enforced in the DB** (triggers, migration 002), not just by absence of endpoints.
- **CSP `worker-src` tightened** to `'self'`; ephemeral-secret generation now logs a loud warning; entity-ID inputs upper-bounded; `.gitignore`/`.dockerignore` broadened to catch `google-sa.json`/`secrets/`; compose gains `no-new-privileges` + `cap_drop: ALL`; `tx()` guards against async misuse.

**Documented / your call (low-impact, not fixed)**
- **Dockerfile base image** pinned by tag (`node:24-slim`), not digest — pin `@sha256:…` for byte-reproducible builds if you want that.
- **Per-username login lockout** (on top of per-IP) — optional extra brute-force defense.
- **Read-only container rootfs** — add `read_only: true` + a `/tmp` tmpfs once you've confirmed nothing writes outside `/data`.
- **CSRF** relies on `SameSite=Strict` (the chosen control); add an Origin check/token only if you want belt-and-suspenders.
- **No-body POSTs** (logout, sheet stubs) skip schema validation — harmless (they ignore the body); left as-is so the no-body logout call doesn't break.

## You'll need to do (for the VPS)

- Create a **production** `.env` on the VPS: `NODE_ENV=production`, strong `APP_PEPPER` + `SESSION_KEY` (`openssl rand -hex 32`), and `SEED_ADMIN_*`.
- `docker compose up -d --build`, then point your TLS reverse proxy at `127.0.0.1:8080`.
- (Docker isn't installed on this Windows machine, so I couldn't build the image here — but every step inside the Dockerfile was verified individually: `npm ci`, `npm run build`, and `node dist/server/index.js` all run clean.)
