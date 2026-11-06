#!/usr/bin/env bash
# compose-smoke.sh MODE IMAGE  — run the BUILT image the way the box runs it, with docker compose,
# and prove full capability (not just a 200), including data surviving a container re-creation.
#
#   legacy    exactly the box's hand-made compose (/root/hosh-deploy/storalex, until the cutover):
#             image USER (node, uid 1000), port 8080 published on 127.0.0.1:8090, writable rootfs,
#             `.env` file, named volume at /data, Google service-account JSON bind-mounted read-only
#             at /run/secrets/google-sa.json, no-new-privileges, cap_drop ALL.
#
# Every mode: wait for the image HEALTHCHECK → /healthz → SPA → first-run setup (argon2id + pepper)
# → place + item + photo (node:sqlite + sharp on the volume) → label PDF → Sheet mirror reads its
# credentials → `compose down` + `up` (new container, same volume) → login with the same password,
# same data, same photo bytes → no error-level logs.
#
# Throwaway fake secrets only. Needs: docker (compose v2), curl, python3, openssl-free.
# Leaves nothing behind (containers, volumes, temp dir) unless KEEP=1.
set -euo pipefail

MODE="${1:?usage: compose-smoke.sh legacy IMAGE}"
IMAGE="${2:?usage: compose-smoke.sh MODE IMAGE}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d)"
PASSWORD='compose-smoke-password-123'

dk() { MSYS_NO_PATHCONV=1 docker "$@"; }
fail() { echo "COMPOSE SMOKE FAIL ($MODE): $*" >&2; exit 1; }
step() { echo "== [$MODE] $*"; }

case "$MODE" in
  legacy)
    PROJECT=storalex                 # /root/hosh-deploy/storalex → project "storalex"
    VOLUME=storalex_storalex-data    # compose-prefixed volume name, as on the box
    BASE=http://127.0.0.1:8090
    WANT_UID=1000
    ;;
  *) fail "unknown mode '$MODE' (legacy)" ;;
esac
CONTAINER=storalex

compose() { (cd "$WORK" && dk compose -p "$PROJECT" "${COMPOSE_ARGS[@]}" "$@"); }

cleanup() {
  local rc=$?
  if [ "$rc" != 0 ]; then
    echo "---- container log ----"; dk logs "$CONTAINER" 2>&1 | tail -n 80 || true
  fi
  if [ "${KEEP:-0}" != 1 ]; then
    compose down -v --remove-orphans >/dev/null 2>&1 || true
    dk volume rm -f "$VOLUME" >/dev/null 2>&1 || true
    rm -rf "$WORK"
  fi
}
trap cleanup EXIT

# A service-account JSON shaped like Google's (fake key: signing fails locally, nothing is sent).
fake_sa_json() {
  printf '%s' '{"type":"service_account","project_id":"smoke","private_key_id":"0","private_key":"-----BEGIN PRIVATE KEY-----\nbm90LWEta2V5\n-----END PRIVATE KEY-----\n","client_email":"smoke@smoke.iam.gserviceaccount.com","client_id":"0","token_uri":"https://oauth2.googleapis.com/token"}'
}

write_legacy() {
  mkdir -p "$WORK/secrets"
  fake_sa_json >"$WORK/secrets/google-sa.json"
  chmod 644 "$WORK/secrets/google-sa.json"
  cat >"$WORK/.env" <<'EOF'
APP_PEPPER=smoke-pepper-not-a-real-secret-0000
SESSION_KEY=smoke-session-key-not-a-real-secret
TRUST_PROXY=1
DATA_DIR=/data
GOOGLE_SERVICE_ACCOUNT_JSON=/run/secrets/google-sa.json
SHEET_ID=smoke-sheet-id
SHEET_SYNC_DEBOUNCE_MS=600000
EOF
  # The box's legacy compose, verbatim except the image reference.
  cat >"$WORK/docker-compose.yml" <<EOF
services:
  storalex:
    image: $IMAGE
    container_name: storalex
    restart: unless-stopped
    env_file: .env
    volumes:
      - storalex-data:/data
      - ./secrets/google-sa.json:/run/secrets/google-sa.json:ro
    ports: ["127.0.0.1:8090:8080"]
    security_opt: ["no-new-privileges:true"]
    cap_drop: [ALL]
volumes:
  storalex-data:
EOF
  COMPOSE_ARGS=(-f docker-compose.yml)
}

wait_healthy() {
  local status=missing
  for _ in $(seq 1 90); do
    status="$(dk inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}nohealthcheck{{end}}' "$CONTAINER" 2>/dev/null || echo missing)"
    [ "$status" = healthy ] && return 0
    [ "$status" = nohealthcheck ] && fail "container has no healthcheck"
    [ "$(dk inspect --format '{{.State.Running}}' "$CONTAINER" 2>/dev/null)" = true ] || fail "container is not running"
    sleep 1
  done
  fail "not healthy after 90s (status=$status)"
}

# code <expected> <curl args...> -> asserts the HTTP status; body in $WORK/body
code() {
  local want="$1"; shift
  local got
  got="$(curl -sS -o "$WORK/body" -w '%{http_code}' "$@")"
  [ "$got" = "$want" ] || { cat "$WORK/body" >&2; echo >&2; fail "expected $want, got $got for: $*"; }
}
json() { python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print(eval(sys.argv[2], {}, {"d": d}))' "$WORK/body" "$1"; }
login() {
  curl -sS -D "$WORK/headers" -o "$WORK/body" -H 'content-type: application/json' \
    -d "{\"username\":\"smoke\",\"password\":\"$PASSWORD\"}" "$BASE/api/auth/$1" >/dev/null
  COOKIE="$(grep -i '^set-cookie: __Host-storalex_sid=' "$WORK/headers" | sed -E 's/^[Ss]et-[Cc]ookie: ([^;]+);.*/\1/' | tr -d '\r')"
  [ -n "$COOKIE" ] || { cat "$WORK/body" >&2; fail "$1 gave no session cookie"; }
}

common_checks() {   # runs on every (re)start
  step "healthy, runs as uid $WANT_UID"
  wait_healthy
  uid="$(dk exec "$CONTAINER" node -e 'process.stdout.write(String(process.getuid()))')"
  [ "$uid" = "$WANT_UID" ] || fail "runs as uid $uid, expected $WANT_UID"
  code 200 "$BASE/healthz"
  [ "$(json 'd["status"]')" = ok ] || fail "/healthz status"
  code 200 "$BASE/"
  grep -q '<div id="root">' "$WORK/body" || fail "SPA index not served"
  code 401 "$BASE/api/items"
}

sheet_reads_credentials() {
  # Configured from the env + credentials; the push fails at signing with the fake key, which
  # proves the JSON was found and parsed (a missing/garbled file fails earlier, differently).
  code 200 -H "cookie: $COOKIE" "$BASE/api/sheet/status"
  [ "$(json 'd["configured"]')" = True ] || fail "Sheet mirror not configured"
  code 502 -X POST -H "cookie: $COOKIE" "$BASE/api/sheet/export"
  if grep -Eqi 'ENOENT|no such file|EACCES|permission denied|JSON|Unexpected token' "$WORK/body"; then
    cat "$WORK/body" >&2; fail "Sheet credentials not readable"
  fi
}

# ---------------------------------------------------------------------------------------------
"write_$MODE"
compose config --quiet || fail "compose file invalid"

step "start (fresh volume)"
dk volume rm -f "$VOLUME" >/dev/null 2>&1 || true
compose up -d --quiet-pull 2>&1 | grep -v -E '^\s*$' || true
common_checks
code 200 "$BASE/api/setup-needed"
[ "$(json 'd["needed"]')" = True ] || fail "fresh volume should need setup"

step "first-run setup + data written"
login setup
printf '%s' 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==' \
  | base64 -d >"$WORK/pixel.png"
code 201 -H "cookie: $COOKIE" -F "file=@$WORK/pixel.png;type=image/png" "$BASE/api/media"
PHOTO="$(json 'd["photo_id"]')"
code 200 -H "cookie: $COOKIE" "$BASE/media/$PHOTO"
PHOTO_SHA="$(sha256sum "$WORK/body" | cut -d' ' -f1)"
code 201 -H "cookie: $COOKIE" -H 'content-type: application/json' -d '{"name":"Compose smoke unit"}' "$BASE/api/places"
PLACE="$(json 'd["id"]')"
code 201 -H "cookie: $COOKIE" -H 'content-type: application/json' \
  -d "{\"name\":\"Compose smoke item\",\"location_place_id\":$PLACE,\"photo_id\":$PHOTO}" "$BASE/api/items"
ITEM="$(json 'd["id"]')"
code 200 -H "cookie: $COOKIE" -H 'content-type: application/json' -d '{"type":"item","count":3}' "$BASE/api/codes/print"
head -c 5 "$WORK/body" | grep -q '%PDF-' || fail "label sheet is not a PDF"
sheet_reads_credentials
dk exec "$CONTAINER" test -s /data/storalex.db || fail "no DB on the /data volume"

step "re-create the container (compose down + up, same volume)"
compose down >/dev/null 2>&1
dk volume inspect "$VOLUME" >/dev/null || fail "volume $VOLUME vanished"
compose up -d 2>&1 | grep -v -E '^\s*$' || true
common_checks

step "same data after re-creation"
code 200 "$BASE/api/setup-needed"
[ "$(json 'd["needed"]')" = False ] || fail "setup needed again: DB lost"
code 401 -H 'content-type: application/json' -d '{"username":"smoke","password":"wrong-password-123"}' "$BASE/api/auth/login"
login login   # same password still verifies: same DB + same APP_PEPPER
code 200 -H "cookie: $COOKIE" "$BASE/api/items/$ITEM"
[ "$(json 'd["name"]')" = 'Compose smoke item' ] || fail "item lost"
[ "$(json 'd["location_place_id"]')" = "$PLACE" ] || fail "item location lost"
code 200 -H "cookie: $COOKIE" "$BASE/media/$PHOTO"
[ "$(sha256sum "$WORK/body" | cut -d' ' -f1)" = "$PHOTO_SHA" ] || fail "photo bytes changed"
code 201 -H "cookie: $COOKIE" -H 'content-type: application/json' -d '{"name":"Written after restart"}' "$BASE/api/places"
sheet_reads_credentials

step "no error-level logs"
dk logs "$CONTAINER" >"$WORK/container.log" 2>&1
if grep -E '"level":(50|60)' "$WORK/container.log"; then fail "error-level log lines"; fi
if grep -Ei 'uncaught|unhandled|segmentation fault' "$WORK/container.log"; then fail "crash markers in logs"; fi

echo "COMPOSE SMOKE OK ($MODE, $IMAGE)"
