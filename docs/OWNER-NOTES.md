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

## Open questions for you (none block deployment)

1. **Users.** It seeds **one** admin from env on first boot. Auth supports multiple users, but there's no "manage users" screen yet. Do you want one, or is single-user fine? (Add more users today by setting env + reseeding, or directly in the DB.)
2. **Label stock.** The PDF prints an **A4 sheet, 24 labels (3×8)**. Is that your sticker sheet (Avery-style), or do you use a label-roll printer (Brother/DYMO)? That changes the PDF page size/layout — tell me your exact stock and I'll match it.
3. **Taggable places?** Right now only **objects** can be tagged. SPEC left this open. Want places taggable too?
4. **History retention.** Movement log is append-only and kept **forever** (recommended). Confirm that's what you want.
5. **Google Sheet mirror (M7).** Deferred. When ready: create a Google Cloud project, a service account, share the target sheet with the service-account email, then set `SHEET_ID` + `GOOGLE_SERVICE_ACCOUNT_JSON`. I'll wire the export/import then. Confirm tab naming (one spreadsheet, tabs: items / places / movements / codes / tags?).
6. **Reverse proxy.** README has an nginx example for `storalex.hosh.it → 127.0.0.1:8080`. Are you on nginx, Caddy, or Traefik? I can give you an exact config for whichever.

## Smaller things I deferred (say the word and I'll add them)

- **Bulk scan-to-move** (scan a destination place, then scan many objects to drop them all there) — SPEC calls it a nice-to-have.
- **History shows `place #N`** rather than the place's name (the audit rows store IDs). Easy to resolve to names if you want prettier history.
- **Multiple photos per object** — schema keeps a single primary photo for now (SPEC v1).
- **Client bundle is ~1 MB** (the `@zxing` QR library is heavy). Fine for self-hosting; can be code-split so the scanner loads lazily if you care about first-load size.

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
