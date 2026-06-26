# StorAlex

Self-hosted personal inventory for a storage unit. Pre-print QR labels, stick them on objects and storage places, then use a phone/tablet to scan things **in** and **out**, track every movement, and tag items for events/exhibitions.

- **Source of truth:** SQLite (single file, via Node's built-in `node:sqlite` — zero native DB dependency).
- **Mirror:** a live-readable Google Sheet *(M7 — deferred; the endpoints exist, the export is stubbed until a Google service account is configured).*
- **Client:** installable PWA, camera QR scanning (rear camera, with a manual-entry fallback).
- **Deploy:** one self-contained Docker image on a VPS, behind your TLS reverse proxy.
- **Stack:** TypeScript end to end — Fastify + node:sqlite + React/Vite.

## Concept

- **Objects** (`item`): minimal data — name + photo. Live in a place, or are "out".
- **Places** (`place`): `unit → shelf → crate`, nestable. Hold objects and child places.
- **Codes** (`code`): QR labels with predictable IDs (`OBJ-000123`, `PLC-000045`). Many codes can point to one object (relabel / lost-label recovery).
- **Movements:** append-only history of in/out/relocate (full audit log).
- **Tags:** flag items for an exhibition/event → instant packing list.

Full design in **[SPEC.md](./SPEC.md)**; build rules in **[AGENTS.md](./AGENTS.md)**; current decisions and open questions in **[docs/OWNER-NOTES.md](./docs/OWNER-NOTES.md)**.

---

## Run it locally

Requires Node 24+ and npm. The repo ships `.npmrc` with `ignore-scripts=true` (keep it — native deps install via prebuilt binaries, no build scripts run).

```bash
npm ci                 # install (lockfile, scripts disabled)
cp .env.example .env    # then fill APP_PEPPER, SESSION_KEY, SEED_ADMIN_USER, SEED_ADMIN_PASSWORD
npm run dev             # Fastify API on :8080 + Vite dev server on :5173
```

Open **http://localhost:5173** and sign in with your `SEED_ADMIN_*` credentials (the first user is created on first boot).

A ready-to-go `.env` for local development needs at minimum:

```env
NODE_ENV=development
APP_PEPPER=<32+ random chars>
SESSION_KEY=<32+ random chars>
SEED_ADMIN_USER=alex
SEED_ADMIN_PASSWORD=<your dev password>
```

> In development, session cookies are **not** marked `Secure`, so login works over plain `http://localhost`. In production they are `Secure` and require HTTPS (your reverse proxy).

### Build a production bundle and run it on one port

```bash
npm run build           # compiles the server -> dist/server and the PWA -> dist/client
npm start               # serves API + PWA together on :8080
```

### Other commands

```bash
npm test                # vitest integration + unit tests
npm run typecheck       # tsc for server and client
npm run seed            # create the first admin from SEED_ADMIN_* (if no users exist)
npm audit               # run after any dependency change
```

---

## Deploy with Docker (VPS)

The image is a multi-stage build that compiles everything and runs as a non-root user. State lives in the `/data` volume (`storalex.db` + `media/`).

1. On the VPS, create a **production** `.env` next to `docker-compose.yml`:

   ```env
   NODE_ENV=production
   APP_PEPPER=<long random secret>
   SESSION_KEY=<long random secret>
   SEED_ADMIN_USER=alex
   SEED_ADMIN_PASSWORD=<strong password>      # used once, on first boot
   ```

   Generate secrets with e.g. `openssl rand -hex 32`.

2. Bring it up:

   ```bash
   docker compose up -d --build
   ```

   The container listens on `127.0.0.1:8080` (not exposed publicly). Point your existing TLS reverse proxy at it.

3. Reverse proxy (for `storalex.hosh.it`, same IP as `hosh.it`) — forward to `http://127.0.0.1:8080`, terminate TLS, and pass through `X-Forwarded-Proto`/`X-Forwarded-For`. Example nginx:

   ```nginx
   server {
     server_name storalex.hosh.it;
     location / {
       proxy_pass http://127.0.0.1:8080;
       proxy_set_header Host $host;
       proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
       proxy_set_header X-Forwarded-Proto $scheme;
     }
     # listen 443 ssl; ... your certs ...
   }
   ```

4. **Backup** = copy the `/data` volume (`storalex.db` + `media/`). That single directory is the entire state.

---

## Status

Milestones **M0–M6** (skeleton, auth, core data, media, codes/print, scan PWA, movements & tags) and **M8** (hardening) are implemented and tested. **M7** (Google Sheet mirror) is deferred — the API endpoints exist but return `501` until a Google service account is configured (`SHEET_ID` + `GOOGLE_SERVICE_ACCOUNT_JSON`).
