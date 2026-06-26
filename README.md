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
   ```

   Generate secrets with e.g. `openssl rand -hex 32`. No admin is seeded — you create the first account in the browser on first visit (see step 4).

2. Bring it up:

   ```bash
   docker compose up -d --build
   ```

   The container listens on `127.0.0.1:8080` (not exposed publicly). Point your existing TLS reverse proxy at it.

3. Reverse proxy — nginx for `storalex.hosh.it` (same IP as `hosh.it`). Terminate TLS and forward to `127.0.0.1:8080`. This is a **single proxy hop**, which matches `TRUST_PROXY=1` so `req.ip` is the real client and per-IP rate limiting can't be spoofed.

   ```nginx
   # /etc/nginx/sites-available/storalex.hosh.it
   server {
     listen 80;
     listen [::]:80;
     server_name storalex.hosh.it;
     # Redirect everything to HTTPS
     return 301 https://$host$request_uri;
   }

   server {
     listen 443 ssl http2;
     listen [::]:443 ssl http2;
     server_name storalex.hosh.it;

     # TLS — e.g. issued by certbot:
     ssl_certificate     /etc/letsencrypt/live/storalex.hosh.it/fullchain.pem;
     ssl_certificate_key /etc/letsencrypt/live/storalex.hosh.it/privkey.pem;

     # Photos are re-encoded server-side but uploads can be up to ~15 MiB.
     client_max_body_size 20m;

     location / {
       proxy_pass http://127.0.0.1:8080;
       proxy_http_version 1.1;
       proxy_set_header Host              $host;
       proxy_set_header X-Real-IP         $remote_addr;
       proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
       proxy_set_header X-Forwarded-Proto $scheme;
       proxy_read_timeout 60s;
     }
   }
   ```

   Get a cert with `certbot --nginx -d storalex.hosh.it` (it can fill in the `ssl_*` lines for you). The app already sets HSTS and a strict CSP, so no extra security headers are needed in nginx.

4. **First account.** Open `https://storalex.hosh.it` — on first visit it prompts you to create the first user. After that it's a normal login; add more users in-app (top-bar `👤` → Users). No public signup once the first account exists.

5. **Backup** = copy the `/data` volume (`storalex.db` + `media/`). That single directory is the entire state.

---

## Google Sheet mirror (read-only)

The app can push a live, read-only copy of the inventory to a Google Sheet (Places / Items / Tags tabs) so other people can consult it. The Sheet never writes back — SQLite stays the source of truth. Setup:

1. Google Cloud → create/choose a project → **enable the Google Sheets API**.
2. Create a **service account**, add a **JSON key**, download it. Note its email (`…@….iam.gserviceaccount.com`).
3. Create a Sheet; copy its id from the URL (`/d/<ID>/edit`).
4. **Share the Sheet with the service-account email as Editor.** Share it with viewers (or "anyone with link → Viewer") for read access.
5. Put the key file somewhere gitignored (e.g. `secrets/google-sa.json` or `/run/secrets/…` on the VPS) and set:
   ```env
   SHEET_ID=<the id>
   GOOGLE_SERVICE_ACCOUNT_JSON=secrets/google-sa.json   # path, or inline JSON
   ```

It syncs automatically (debounced) after any change, on a periodic reconcile, and on demand via **Admin → Sync now**. If Google rejects a sync the app keeps running and shows one clear error (e.g. "share the Sheet with the service account").

## Status

Milestones **M0–M8** are implemented and tested, including **M7** (Google Sheet mirror, read-only).
