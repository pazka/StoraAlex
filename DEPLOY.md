# Deploying storalex.hosh.it

Deployment on the hosh.it box (box standard: hosh-migration `11-BOX-STANDARD.md`). Releases deploy
themselves through **hosh-deploy** (§1). StorAlex was first deployed by hand (legacy compose in
`/root/hosh-deploy/storalex`); **§1b is the one-time cutover** from it, keeping the SQLite DB,
photos, users and passwords exactly.

| | |
|---|---|
| Image | `ghcr.io/pazka/storalex:vX.Y.Z` (Node 26 slim, non-root) |
| Host | `storalex.hosh.it` |
| Loopback port | `127.0.0.1:9138` → container port 8000 |
| Data | docker volume `storalex-data` → `/data` (`storalex.db` + WAL, `media/`) |
| Env file | `/srv/storalex/storalex.env` (root, 600): secrets |
| Health | `GET /healthz` → `{"status":"ok","db":"ok","migrations":5,"storage":"writable"}` |

## 1. How releases go live (hosh-deploy is the only deploy path on the box)

`release` workflow (tag `vX.Y.Z`): build → Node guardrail → Trivy CRITICAL gate → push `:vX.Y.Z`,
`:<sha>`, `:latest` → job **`deploy`** (`deploy.yml`): GitHub connects to the box as `deployer` with
this repo's `HOSH_DEPLOY_KEY` (bound to storalex only) and runs `hosh-deploy deploy storalex vX.Y.Z`.
The box pulls the image, swaps the tag in `storalex.env`, waits healthy, checks non-root + read-only
rootfs, `/healthz` on the loopback port and through Traefik, runs `POST_DEPLOY` inside the container
(`deploy/hosh-deploy.conf`) and **rolls back by itself** if any check fails (the workflow goes red).

- Prerelease tags (`vX.Y.Z-rc.N`) build and push `:vX.Y.Z-rc.N` only: never `:latest`, never deployed.
- Until `HOSH_DEPLOY_KEY` exists, the `deploy` job prints a notice and deploys nothing, so releases
  keep working for the legacy compose (it pins `ghcr.io/pazka/storalex:vX.Y.Z` by hand).
- Redeploy / roll forward / back: Actions → **deploy** → `vX.Y.Z`, `rollback` or `status`.
- On the box (owner, or the on-box Claude without a sudo window): `sudo hosh-deploy deploy storalex vX.Y.Z`,
  `sudo hosh-deploy rollback storalex`, `sudo hosh-deploy status storalex`. Log: `/var/log/hosh-deploy.log`.
- Repo variable `HOSH_AUTODEPLOY=false` stops auto-deploy after releases (manual dispatch still works).

## 1b. Cutover from legacy (once; on-box Claude in an owner-opened sudo window)

Box rules: `ACTIONS-LOG.md` intent BEFORE, result + revert AFTER; `/home/pazka/MIGRATION/scripts/smoke.sh`
BEFORE and AFTER. The whole sequence (C → G) runs in CI against the real image:
`scripts/compose-smoke.sh cutover` executes the two marked shell blocks below **verbatim** and
proves that the copy is byte-identical, that the same users log in with the same passwords, that
photos and items come back, and that rollback finds the legacy volume untouched.

**Prerequisites**
- A release `vX.Y.Z` (≥ v1.2.0, the first one with `deploy/`) built by the `release` workflow.
  Below, replace `vX.Y.Z` with it.
- **The GHCR package `storalex` must be public** (owner: GitHub → package settings → visibility),
  otherwise the box cannot pull it (11-BOX-STANDARD §6, X.28).
- DNS `storalex.hosh.it` already points to the box (legacy). Port 9138 is in the port registry.
- Downtime: from step D (legacy stopped) to the end of step H (a few minutes).

```sh
# A: baseline (read-only). Smoke BEFORE, legacy state, image pullable.
cd /root/hosh-deploy/storalex && sudo docker compose ps
sudo docker inspect storalex -f '{{.Config.Image}} {{range .Mounts}}{{.Type}}:{{.Name}}{{.Source}}->{{.Destination}} {{end}}'
#    expect: ghcr.io/pazka/storalex:v1.1.1 volume:storalex_storalex-data->/data bind:…/secrets/google-sa.json->/run/secrets/google-sa.json
IMAGE=ghcr.io/pazka/storalex:vX.Y.Z
sudo docker pull "$IMAGE"
# B: release checkout (provides docker-compose.example.yml, .env.example, deploy/*)
sudo mkdir -p /srv/storalex && sudo chmod 750 /srv/storalex
sudo bash -c 'cd /srv/storalex && { [ -d .git ] || { git init -q && git remote add origin https://github.com/pazka/StoraAlex; }; } && git fetch -q --depth 1 origin tag vX.Y.Z && git checkout -q vX.Y.Z'
sudo bash -c 'cd /srv/storalex && { [ -e storalex.env ] || install -m 600 .env.example storalex.env; }'
```

**C: secrets move from the legacy container to `storalex.env`** (owner, or the coordinator with the
owner's explicit yes; prints names only, never values). The values are taken from what the legacy
app *actually received* (`docker inspect`), not from the `.env` text, so compose interpolation of
the old file cannot change them. **`APP_PEPPER` must be the exact old value**: a new one locks
every user out. Moved: `APP_PEPPER`, `SESSION_KEY` (both required), `SHEET_ID`,
`SHEET_SYNC_DEBOUNCE_MS` (if set), and the service-account JSON (bind-mounted file, or inline
value) → `GOOGLE_SERVICE_ACCOUNT_JSON_B64` (base64, one line: hosh-deploy allows no file mounts).
Not moved: `TRUST_PROXY` (the box value `127.0.0.0/8,::1/128,172.16.0.0/12` from `.env.example`
replaces `1`), `DATA_DIR`/`PORT` (fixed by the compose file), `GOOGLE_SERVICE_ACCOUNT_JSON` (stays
empty).

<!-- cutover:env (run verbatim by scripts/compose-smoke.sh cutover) -->
```sh
sudo python3 - /srv/storalex/storalex.env <<'PY'
import base64, json, os, subprocess, sys
dst = sys.argv[1]
c = json.loads(subprocess.check_output(["docker", "inspect", "storalex"]))[0]
env = dict(e.split("=", 1) for e in c["Config"]["Env"])
out = {k: env[k] for k in ("APP_PEPPER", "SESSION_KEY", "SHEET_ID", "SHEET_SYNC_DEBOUNCE_MS") if env.get(k)}
sa = env.get("GOOGLE_SERVICE_ACCOUNT_JSON", "").strip()
if sa.startswith("{"):
    out["GOOGLE_SERVICE_ACCOUNT_JSON_B64"] = base64.b64encode(sa.encode()).decode()
elif sa:
    src = [m["Source"] for m in c["Mounts"] if m["Destination"] == sa]
    if not src:
        sys.exit("GOOGLE_SERVICE_ACCOUNT_JSON points to %s, which is not a mount: STOP" % sa)
    raw = open(src[0], "rb").read()
    json.loads(raw)  # must be the JSON key file
    out["GOOGLE_SERVICE_ACCOUNT_JSON_B64"] = base64.b64encode(raw).decode()
for k in ("APP_PEPPER", "SESSION_KEY"):
    if len(out.get(k, "")) < 16:
        sys.exit("%s missing or too short in the legacy container: STOP" % k)
lines = open(dst).read().splitlines()
for k, v in out.items():
    if "'" in v or "\n" in v:
        sys.exit("%s contains a quote or newline: set it by hand, single-quoted" % k)
    lines = [l for l in lines if not l.startswith(k + "=")] + ["%s='%s'" % (k, v)]
open(dst, "w").write("\n".join(lines) + "\n")
os.chmod(dst, 0o600)
print("moved into %s: %s" % (dst, " ".join(sorted(out))))
PY
```

**D-E: stop the legacy app, copy its volume into `storalex-data`, owned by uid 10001.** The legacy
container is stopped (not removed: it is the rollback). SQLite closes cleanly on SIGTERM (WAL
checkpointed), then the files are copied with `cp -a` and verified by sha256, file by file. The
legacy volume is mounted read-only and never changed. If `storalex-data` already exists, the block
stops: inspect it before doing anything else.

<!-- cutover:copy (run verbatim by scripts/compose-smoke.sh cutover) -->
```sh
(cd /root/hosh-deploy/storalex && sudo docker compose stop)
LEGACY_VOL="$(sudo docker inspect storalex -f '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Name}}{{end}}{{end}}')"
echo "legacy volume: $LEGACY_VOL"   # expect storalex_storalex-data
if [ "$(sudo docker inspect storalex -f '{{.State.Running}}')" != false ] || [ -z "$LEGACY_VOL" ]; then
  echo "STOP: legacy still running or no /data volume"
elif sudo docker volume inspect storalex-data >/dev/null 2>&1; then
  echo "STOP: storalex-data already exists"
else
  sudo docker volume create storalex-data >/dev/null &&
  sudo docker run --rm --network none --user 0:0 --entrypoint sh \
    -v "$LEGACY_VOL":/from:ro -v storalex-data:/to "$IMAGE" -c '
      set -e
      cp -a /from/. /to/
      chown -R 10001:10001 /to
      (cd /from && find . -type f -exec sha256sum {} + | sort -k2) > /tmp/from.sum
      (cd /to && find . -type f -exec sha256sum {} + | sort -k2) > /tmp/to.sum
      [ "$(cat /tmp/from.sum)" = "$(cat /tmp/to.sum)" ] || { echo "STOP: COPY DIFFERS"; exit 1; }
      [ -z "$(find /to ! -uid 10001 -o ! -gid 10001)" ] || { echo "STOP: OWNERSHIP NOT 10001"; exit 1; }
      cat /tmp/to.sum; echo "copy identical, owned by 10001:10001"'
fi
```
Log the printed sha256 list in ACTIONS-LOG (it names `storalex.db`, `media/*.webp`).

```sh
# F: pin the box config (validates the compose hardening + the required secrets). No deploy from here.
sudo hosh-deploy register storalex
# G: legacy router out of the edge: the coordinator deletes the storalex.hosh.it router + service
#    from /root/hosh-deploy/edge/traefik/dynamic/routes.yml (keep the block in ACTIONS-LOG for the
#    rollback; Traefik hot-reloads). hosh-deploy writes dynamic/storalex.yml on the first healthy deploy.
# H: GitHub key (claude_agent: keygen; root: bind; gh: secret; private key shredded). If the agent is
#    blocked here, the owner runs these lines with `!`.
ssh-keygen -q -t ed25519 -N '' -C hosh-deploy:storalex -f /tmp/storalex-deploy
sudo /home/pazka/MIGRATION/scripts/setup-hosh-deploy.sh key storalex /tmp/storalex-deploy.pub
gh secret set HOSH_DEPLOY_KEY -R pazka/StoraAlex < /tmp/storalex-deploy && shred -u /tmp/storalex-deploy /tmp/storalex-deploy.pub
# I: first deploy from CI (writes the Traefik route, runs POST_DEPLOY, rolls back by itself)
gh workflow run deploy -R pazka/StoraAlex -f version=vX.Y.Z
```
Then: box smoke AFTER (add/adjust `svc_storalex` in `scripts/smoke.sh` from §3: host
`storalex.hosh.it`, upstream `127.0.0.1:9138`, `/healthz` fields), the owner logs in at
https://storalex.hosh.it with their usual password (proves DB + pepper), opens an item with a photo,
and presses "Sync now" on the Sheet page (status `lastError` empty: the credentials moved). Commit
the route in `/root/hosh-deploy`, set the port-registry line to `live`, Actions → deploy → `status`.

**Rollback** (legacy back, its volume untouched since step D):
```sh
cd /srv/storalex && sudo docker compose --env-file storalex.env down     # keeps storalex-data
sudo rm -f /root/hosh-deploy/edge/traefik/dynamic/storalex.yml           # put the routes.yml block back
(cd /root/hosh-deploy/storalex && sudo docker compose start)
```
Anything written in the new app after the cutover is only in `storalex-data`; to keep it on
rollback, copy back the other way (same C2 commands with the volumes swapped and `chown -R 1000:1000`).
Full revert also: `sudo rm /etc/hosh-deploy/apps/storalex.conf`,
`sudo …/setup-hosh-deploy.sh unkey storalex`, `gh secret delete HOSH_DEPLOY_KEY -R pazka/StoraAlex`.
**Later** (owner decision, after a few days and a golden backup): `docker compose down` in
`/root/hosh-deploy/storalex` and remove `storalex_storalex-data` + `secrets/google-sa.json` there.

## 2. Variables (`storalex.env`, mode 600)
| Variable | Default (`.env.example`) | Set by | Meaning |
|---|---|---|---|
| `APP_IMAGE` | `ghcr.io/pazka/storalex:v1.2.0` | hosh-deploy | Release running (the only line hosh-deploy rewrites). |
| `APP_BIND` | `127.0.0.1:9138` | template | Loopback port published for Traefik. |
| `NODE_ENV` | `production` | template | Secure cookies, CSP, secrets required. |
| `TRUST_PROXY` | `127.0.0.0/8,::1/128,172.16.0.0/12` | template | X-Forwarded-For trusted only from loopback / docker gateway (Traefik via docker-proxy). |
| `APP_PEPPER` | (empty, **required**) | owner (§1b C) | argon2id pepper. Never change it: every password would stop verifying. |
| `SESSION_KEY` | (empty, **required**) | owner (§1b C) | Cookie signing key (changing it logs everyone out). |
| `SHEET_ID` | (empty) | owner | Google Sheet mirror target; empty = mirror off. |
| `GOOGLE_SERVICE_ACCOUNT_JSON_B64` | (empty) | owner | Service-account JSON key, `base64 -w0`. |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | (empty) | n/a | Path or inline JSON (legacy); wins over `_B64` if set. Leave empty. |
| `SHEET_SYNC_DEBOUNCE_MS` | `10000` | template | Delay before pushing changes to the Sheet. |
| `PORT`, `DATA_DIR` | `8000`, `/data` | compose file | Fixed in `docker-compose.example.yml`; not in the env file. |
| `SEED_ADMIN_*`, `DB_PATH`, `MEDIA_DIR`, `HOST`, `SESSION_TTL_DAYS`, `MAX_UPLOAD_BYTES` | unset | n/a | Local/tuning only; leave unset. |

Single-quote any value containing `$` (the file also feeds compose interpolation).

## 3. Capability checks (what "works" means, beyond a 200)
`POST_DEPLOY` = `/usr/local/bin/node /app/dist/server/postdeploy.js http://127.0.0.1:8000` runs
inside the container after every deploy (non-zero ⇒ rollback). It never writes data:

| Feature | Request → expected |
|---|---|
| Health | `GET /healthz` → 200 `{"status":"ok","db":"ok","migrations":5,"storage":"writable"}`; 503 if the DB fails or `/data` (or `media/`) is not a writable directory |
| PWA | `GET /` → 200 HTML with `<div id="root">`, CSP `default-src 'self'`; its `/assets/*.js`, `/registerSW.js`, `/sw.js` → 200 JavaScript; `/manifest.webmanifest` name StorAlex; `/items/1` → SPA index |
| Auth gate | `GET /api/me`, `/api/items`, `/api/places`, `/media/1` → 401; `GET /api/setup-needed` → 200 `{"needed":false}` on the migrated DB |
| No leaks | `/.env`, `/package.json`, `/dist/server/index.js` never return sources or secrets |
| Native modules | argon2id hash + verify and a sharp re-encode, in memory |

Box smoke / by hand after the cutover (needs the owner's login): `POST /api/auth/login` with the
owner's account → 200 + `__Host-storalex_sid` cookie (Secure, HttpOnly, SameSite=Strict);
`GET /api/items` → the existing inventory; `GET /media/<id>` → the photo; Sheet page → "Sync now"
→ `lastSync` set, `lastError` empty. CI runs the full write path (setup, place, item, photo upload,
label PDF, restart, same data) in `scripts/compose-smoke.sh template` and `cutover`.

## 4. What runs
| Item | Value |
|---|---|
| Image | `ghcr.io/pazka/storalex:vX.Y.Z` (`node:26.13.1-slim` pinned by digest; uid 10001 via compose) |
| Upstream | container :8000 → `127.0.0.1:9138` |
| Edge | `/root/hosh-deploy/edge/traefik/dynamic/storalex.yml` (router `storalex@file`, resolver `le`, HSTS) |
| Volume | `storalex-data` → `/data` (monthly restic golden via `/var/lib/docker/volumes`) |
| Hardening | read-only rootfs, tmpfs `/tmp` 16m, cap_drop ALL, no-new-privileges, pids 128, mem 512m |
| Outbound | only when the Sheet mirror is configured: `oauth2.googleapis.com`, `sheets.googleapis.com` |

## 5. Decisions / known limits
- **Same image, two composes.** Until the cutover the box runs the legacy compose (image user
  uid 1000, port 8080, `.env`, bind-mounted service-account file). The image keeps those defaults
  (`PORT=8080`, `DATA_DIR=/data`, `USER node`); `docker-compose.example.yml` sets `PORT=8000` and
  `user: "10001:10001"`. `/data` in the image is `node:10001` mode `0770`, so a fresh volume is
  writable in both modes; the migrated volume is chowned to 10001 (§1b). CI runs both modes and
  the cutover on every PR (`scripts/compose-smoke.sh legacy|template|cutover`).
- **Service account as base64 env.** hosh-deploy refuses bind mounts and the env file is the only
  secret channel. Base64 has no quotes, `$` or newlines, so it survives env-file parsing and compose
  interpolation unchanged. A file inside the data volume was rejected: the key would then sit in the
  monthly volume backups and be writable by the app.
- **Trust proxy:** the box value is the CIDR list (Traefik reaches the app through docker-proxy from
  172.x); the legacy `TRUST_PROXY=1` (one hop) gives the same client IP and stays supported.
- `scripts/register-check.sh` is a copy of `hosh-deploy register`'s checks (hosh-migration
  `scripts/hosh-deploy`); keep it in sync when the box tool changes.
