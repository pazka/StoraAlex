# StorAlex — Specification

**Owner:** Alexandre (alexandre.weisser@gmail.com)
**Status:** Spec v1 — ready for implementation by a separate Claude session.
**One-line:** Self-hosted personal storage-unit inventory. Pre-print QR labels, scan objects and storage places in/out with a phone/tablet, track movements, tag items for events/exhibitions. SQLite is the source of truth; a Google Sheet is a live mirror.

---

## 1. Goals

1. Print a batch of QR labels ahead of time, stick them on physical objects and storage places.
2. At the storage unit, using **phone or tablet camera**, scan to:
   - add a new object (scan its label → take photo → set where it's stored),
   - register a storage place (scan place label → info → can hold objects),
   - move an object **in** to a place or **out** of storage (scan object, then scan/pick destination),
   - look up "what is this?" by scanning any label.
3. Keep object metadata minimal: **name + photo** is enough. Everything else optional.
4. Nest storage: **storage unit → shelf → crate → object**. Know which objects are in which crate, which crates on which shelf.
5. **Tag** objects (e.g. "Exhibition X", "Important") to filter what is stored / taken out for an event.
6. Full **movement history** (audit log): what went in/out, when, where, how (scan vs manual).
7. **Manual** create/edit/move from the UI is always possible, in addition to scanning.
8. Data is **importable/exportable**: SQLite is truth; mirror to a Google Sheet readable live in the Drive app; allow import back.
9. Ship as a **single self-contained Docker image** deployable on the owner's VPS.
10. **Secured:** login/password (hashed with per-user salt + app pepper), no public signup, images access-controlled.

### Non-goals (v1)
- Multi-tenant / multiple separate users' inventories. Assume **a small set of trusted users** sharing one inventory (default: one user; auth supports more).
- Barcode formats other than QR.
- Offline-first sync engine. Network is assumed available at the storage unit (phone data). A light "queue failed scans" nicety is optional, not required.
- Quantities/stock counts, prices, suppliers. This is unique physical objects, not retail stock.

---

## 2. Core decisions (locked)

| Topic | Decision |
|---|---|
| Source of truth | **SQLite** (single file on a Docker volume). Transactional, fast, safe under concurrent scans. |
| Google Sheet | **Live mirror only.** App pushes DB → Sheet so it's readable in Drive. Import path exists but DB always wins. |
| Scanning device | **PWA** on phone/tablet, camera-based QR scanning in the browser. Installable to home screen. |
| Photos | Camera capture, **downscaled** server-side (legible, not hi-res). Target max ~1600px long edge, WebP/JPEG q~80, EXIF stripped. |
| Label codes | **QR** encoding a **predictable structured ID** (not random UUID). e.g. `OBJ-000123`, `PLC-000045`. |
| Multiple codes → one entity | Supported. An object/place can have **several codes** (relabeling, lost-label recovery). One entity has many codes; each code resolves to exactly one entity. |
| Language | **TypeScript** end to end. |
| DB access | Parameterized/prepared statements only. No string-built SQL. No heavy ORM required. |

### Note on "predictable IDs"
Predictable IDs are **enumerable** — anyone who can read one label can guess others. That is acceptable here because **the IDs are not a security boundary**: every read/write requires authentication. Treat codes as convenient handles, never as secrets. (If owner later wants unguessable labels, add a random short suffix `OBJ-000123-7f3a`; the resolver already maps many codes → one entity so this is non-breaking.)

---

## 3. Architecture

Single Node.js process serves both the JSON API and the built PWA static assets (one image, one port).

```
            ┌─────────────────────────── Docker image ───────────────────────────┐
 Phone/     │  Node 24 + TypeScript                                               │
 Tablet ───▶│  Fastify  ─┬─ /api/*   JSON API (schema-validated)                  │
 (PWA,      │            ├─ /        PWA static (built React+Vite)                │
  camera)   │            └─ /media/* authenticated image serving                  │
            │                                                                     │
            │  better-sqlite3 ──▶  /data/storalex.db   (volume)                   │
            │  sharp          ──▶  /data/media/*.webp  (volume)                   │
            │  googleapis     ──▶  Google Sheet (mirror, outbound)                │
            └─────────────────────────────────────────────────────────────────────┘
                         volume: /data  (db + images, persisted on VPS)
```

### Recommended stack
- **Runtime:** Node 24 LTS, TypeScript (strict).
- **HTTP:** **Fastify** — JSON-Schema validation on every route is a first-class anti-injection control (reject malformed input before it touches logic/DB).
- **DB:** **better-sqlite3** (synchronous, prepared statements). Ships prebuilt binaries → works with install-scripts disabled. *Alternative:* Node's built-in `node:sqlite` (zero native deps) if the team prefers no compiled dependency; it is still marked experimental, so better-sqlite3 is the safer default.
- **Migrations:** plain SQL files run on boot, tracked in a `schema_migrations` table. No migration framework needed.
- **Auth:** `argon2` (argon2id) for password hashing; **httpOnly + Secure + SameSite=Strict** signed session cookie via `@fastify/cookie` + `@fastify/secure-session`. Server-side session table in SQLite.
- **Hardening:** `@fastify/helmet` (CSP, security headers), `@fastify/rate-limit` (throttle `/api/auth/login`), strict CORS (same-origin; the PWA is served by the same app).
- **Images:** `sharp` for resize/recompress/EXIF-strip on upload. Store under `/data/media`, serve only through an authenticated route.
- **Frontend:** **React + Vite + TypeScript**, PWA (manifest + service worker). QR scan via `BarcodeDetector` API where available, fallback `@zxing/browser`. Server state via TanStack Query.
- **Label printing:** server generates a **PDF sheet** of QR labels for a batch of pre-allocated codes (`qrcode` to render, `pdf-lib` or `pdfkit` to lay out a printable grid, e.g. Avery-style).
- **Sheets mirror:** `googleapis` with a **Google service account** (share the target Sheet with the service-account email). Push-on-change, debounced + a periodic full reconcile.

> All package choices are **recommendations**. The implementer must vet each one (see AGENTS.md §security) and may substitute an equivalent if a package has a bad security history. Bias toward **few, well-maintained dependencies.**

---

## 4. Data model

Entities and key fields (final column list is the implementer's, but keep these semantics).

### `user`
- `id` (pk), `username` (unique), `password_hash` (argon2id), `created_at`, `last_login_at`.

### `session`
- `id` (random), `user_id`, `created_at`, `expires_at`, `user_agent`. (Or use stateless secure-session; server-side table preferred so logout/revoke works.)

### `place` — a storage location (nestable)
- `id` (pk), `code_display` e.g. `PLC-000045`,
- `type` enum: `unit` | `shelf` | `crate`. (A crate can also be treated as a container that holds objects.)
- `name`, `photo_id` (nullable), `info` (free text, optional),
- `parent_place_id` (nullable, self-FK) — nesting unit→shelf→crate,
- `created_at`, `updated_at`.

### `item` — an object
- `id` (pk), `code_display` e.g. `OBJ-000123`,
- `name`, `photo_id` (nullable, primary photo),
- `location_place_id` (nullable; `NULL` = **out of storage / removed**),
- `notes` (optional),
- `created_at`, `updated_at`.

### `code` — physical label → entity resolver (many codes → one entity)
- `id` (pk), `code_value` (unique; the exact string encoded in the QR, e.g. `OBJ-000123`),
- `entity_type` enum: `item` | `place`,
- `entity_id` (FK to item or place; nullable while **pre-printed but unassigned**),
- `status` enum: `unassigned` | `active` | `retired`,
- `created_at`.
- Pre-printed labels are rows with `status=unassigned`, `entity_id=NULL`. Scanning an unassigned code triggers the "create new item/place?" flow.

### `tag`
- `id` (pk), `name` (unique), `color`, `kind` enum: `event` | `flag` | `other` (e.g. an exhibition is `event`, "important" is `flag`).

### `item_tag` (join)
- `item_id`, `tag_id`. (Tags on items. Optionally allow tagging places too in a later version.)

### `movement` — append-only audit log
- `id` (pk), `at` (timestamp), `user_id`,
- `entity_type` (`item` | `place`), `entity_id`,
- `action` enum: `created` | `moved_in` | `moved_out` | `relocated` | `edited` | `tagged` | `untagged` | `retired`,
- `from_place_id` (nullable), `to_place_id` (nullable),
- `method` enum: `scan` | `manual`,
- `note` (nullable).
- **Never updated or deleted.** This is the "what went in/out" history.

### `photo`
- `id` (pk), `path` (relative under `/data/media`), `width`, `height`, `bytes`, `created_at`.

> Multiple photos per item later = a `photo.item_id` or a join table. v1 can keep a single `photo_id` on item/place and still store the file via the `photo` table.

---

## 5. Key flows

### 5.1 Pre-print labels
1. Owner requests N labels for a type (`item` or `place`).
2. Server allocates N sequential codes (`OBJ-000124…`), inserts `code` rows `status=unassigned`.
3. Server returns a **printable PDF grid** of QR codes (+ human-readable ID under each).
4. Owner prints, sticks labels on physical objects/places.

### 5.2 Add an object (at the unit)
1. Scan a label.
2. Code resolves:
   - `unassigned` → "Create new object" form (name; capture photo; set location by scanning a place or picking from list).
   - `active` (already an item) → open that item.
3. Save → `item` created, `code` → `status=active`, `movement` `created` (+ `moved_in` if a location was set), photo stored.

### 5.3 Register a storage place
Same as 5.2 but creates a `place` (choose `unit`/`shelf`/`crate`, optional parent, photo, info).

### 5.4 Move in / move out / relocate
- **Move out:** scan object → "Take out of storage" → `location_place_id = NULL`, `movement` `moved_out` (from = old place).
- **Move in / relocate:** scan object, then scan or pick a place → set `location_place_id`, `movement` `moved_in` or `relocated`.
- **Bulk:** scan a place first ("set destination"), then scan many objects → each gets that location. (Nice-to-have, reduces taps.)

### 5.5 Look up
Scan any label → if `item`, show item + current location breadcrumb (unit > shelf > crate) + tags + history; if `place`, show place + its contents (objects, child places).

### 5.6 Tag for an event
Create/select a tag (`kind=event` for exhibitions). Apply to items. Filter: "show all items tagged 'Exhibition X'" and their current location / in-or-out status → packing list for the event.

### 5.7 Manual everything
Every create/edit/move/tag is doable from the UI without scanning (forms + pickers). Scanning is a shortcut, never the only path.

### 5.8 Google Sheet mirror
- On change (debounced) and on a periodic timer, export DB tables (items, places, codes, tags, movements) to tabs in the configured Sheet.
- Sheet is **read-only truth-wise**: a manual **Import** action can pull the Sheet back in with an explicit diff/confirm, but DB remains authoritative. Document that editing the Sheet directly is for viewing, not the primary edit path.

---

## 6. API surface (sketch)

All under `/api`, all authenticated except `auth/login`. All bodies JSON-Schema validated.

```
POST   /api/auth/login            {username,password} -> set cookie
POST   /api/auth/logout
GET    /api/me

GET    /api/items?tag=&place=&status=in|out&q=
POST   /api/items                 create
GET    /api/items/:id
PATCH  /api/items/:id             edit name/notes/photo
POST   /api/items/:id/move        {to_place_id|null, method}
POST   /api/items/:id/tags        {tag_id}        DELETE /api/items/:id/tags/:tagId

GET    /api/places?parent=&type=
POST   /api/places
GET    /api/places/:id            includes contents (items + child places)
PATCH  /api/places/:id
POST   /api/places/:id/move       relocate a place under another

GET    /api/resolve/:code         -> {entity_type, entity_id|null, status}  (scan endpoint)
POST   /api/codes/print           {type, count} -> allocate + return PDF
POST   /api/codes/assign          {code_value, entity_type, entity_id}      (attach extra/replacement label)

GET    /api/tags                  POST /api/tags
GET    /api/movements?entity=&from=&to=          (history / audit)

POST   /api/media                 multipart upload -> resize -> {photo_id}
GET    /media/:photoId            authenticated image

POST   /api/sheet/export          force mirror push
POST   /api/sheet/import          pull + diff + confirm
```

---

## 7. Security requirements (must-have)

These are **acceptance criteria**, not suggestions.

1. **AuthN:** argon2id password hashing with a unique per-hash salt (argon2 does this) **plus a server-side secret pepper** (`APP_PEPPER` env, never in DB). No public registration; first user seeded via env/CLI on first boot.
2. **AuthZ:** every `/api/*` (except login) and `/media/*` requires a valid session. No object/photo is reachable unauthenticated.
3. **Session cookie:** `httpOnly`, `Secure`, `SameSite=Strict`, signed; reasonable expiry + server-side revocation on logout.
4. **Input validation:** Fastify JSON Schema on every route (types, lengths, enums). Reject unknown fields.
5. **SQL:** prepared/parameterized statements only. Zero string concatenation into SQL.
6. **XSS:** React auto-escaping; no `dangerouslySetInnerHTML`. Strict **CSP** via helmet; no inline scripts.
7. **Uploads:** verify MIME/magic bytes, cap size, re-encode through sharp (defangs malicious payloads), strip EXIF, random stored filenames. Never serve user files from a path the user controls.
8. **Rate limiting:** login + resolve endpoints throttled; lockout/backoff on repeated login failure.
9. **Secrets:** all secrets (pepper, session key, Google service-account JSON) from env/secret files, never committed. `.env.example` documents them.
10. **Transport:** app assumes a TLS-terminating reverse proxy on the VPS (owner deploys behind it). Set HSTS, trust-proxy correctly. Cookies Secure-only.
11. **No prompt injection surface:** the app contains **no LLM**, so prompt injection is N/A by design. Do not add any LLM/AI feature that ingests item names/notes into a model without revisiting this.

### Supply-chain / build-machine safety (applies to the implementer's own machine)
See **AGENTS.md** — vet each package before install, install with lifecycle scripts disabled, pin versions, commit the lockfile, keep dependencies minimal.

---

## 8. Deployment

- **Single image**, multi-stage Dockerfile: build frontend (Vite) + compile TS, then a slim runtime stage running as a **non-root** user.
- **Volume** `/data` holds `storalex.db` and `media/`. Nothing stateful in the image.
- **Config** via env: `APP_PEPPER`, `SESSION_KEY`, `PORT`, `GOOGLE_SERVICE_ACCOUNT_JSON` (or path), `SHEET_ID`, `SEED_ADMIN_USER`/`SEED_ADMIN_PASSWORD` (first boot only).
- `docker-compose.yml` for the VPS: the app + a mounted `/data` volume; owner runs it behind their existing reverse proxy/TLS. (Owner will walk through their VPS deploy flow later — keep the image proxy-agnostic.)
- **Backups:** since truth is one SQLite file + media dir, a backup = copy `/data`. The Sheet mirror is a secondary human-readable backup. Document a `sqlite3 .backup` or litestream option as a later enhancement.

---

## 9. Build order (suggested milestones)

1. **M0 Skeleton:** repo, TS configs, Fastify hello, Vite PWA shell, Docker build, `/data` volume, health check.
2. **M1 Auth:** user seed, login/logout, session cookie, protected routes, rate limit.
3. **M2 Core data:** schema + migrations; items, places (nesting), codes; CRUD API; manual UI.
4. **M3 Media:** photo upload → sharp resize → authenticated serve.
5. **M4 Codes & print:** allocate codes, PDF label sheet, `resolve` endpoint.
6. **M5 Scan PWA:** camera QR scan → resolve → add/move/lookup flows.
7. **M6 Movements & tags:** audit log on every change; tags incl. event tags; filters / packing-list view.
8. **M7 Sheet mirror:** service-account export; import-with-diff.
9. **M8 Hardening:** helmet/CSP, upload checks, audit pass against §7, README deploy guide.

Each milestone: tests first where it counts (auth, resolve, move, code-assignment), then implement (see AGENTS.md for TDD + security workflow).

---

## 10. Open questions for the owner (resolve during build, don't block M0–M3)

- Single user only, or seed 2–3 named users? (Auth supports many; default seed = 1.)
- Label stock/printer: plain A4 sticker sheets (Avery layout) or a label-roll printer (Brother/DYMO)? Affects PDF layout dimensions.
- Should **places** also be taggable (not just items)?
- Retention: keep movement history forever (recommended) — confirm.
- Sheet: one spreadsheet with multiple tabs (items/places/movements) — confirm naming.
