#!/usr/bin/env bash
# Container smoke test (upgrade safety net, see TESTING.md).
# Starts the BUILT image with its production hardening flags, waits for the
# image's own HEALTHCHECK, exercises real endpoints (SQLite, argon2, sharp,
# pdf-lib all run inside the image), and fails on error-level log lines.
#
#   docker build -t storalex:smoke . && bash scripts/smoke.sh storalex:smoke
#
# Uses throwaway fake secrets only. Needs: docker, curl.
set -euo pipefail

IMAGE="${1:-storalex:smoke}"
NAME="storalex-smoke-$$"
PORT="${SMOKE_PORT:-18080}"
BASE="http://127.0.0.1:${PORT}"
TMP="$(mktemp -d)"
cd "$TMP" # upload fixtures are referenced by relative name (portable curl -F)

cleanup() {
  cd /
  dk logs "$NAME" >"$TMP/container.log" 2>&1 || true
  if [ "${SMOKE_OK:-0}" != 1 ]; then
    echo "---- container log ----"
    cat "$TMP/container.log" || true
  fi
  dk rm -f "$NAME" >/dev/null 2>&1 || true
  dk volume rm -f "$NAME-data" >/dev/null 2>&1 || true
  rm -rf "$TMP"
}
trap cleanup EXIT

# Git Bash on Windows rewrites /paths in args; harmless elsewhere.
dk() { MSYS_NO_PATHCONV=1 docker "$@"; }

fail() { echo "SMOKE FAIL: $*" >&2; exit 1; }
step() { echo "== $*"; }

step "start $IMAGE (read-only rootfs, cap_drop ALL, no-new-privileges)"
dk run -d --name "$NAME" \
  --read-only --tmpfs /tmp \
  --cap-drop ALL --security-opt no-new-privileges:true \
  --health-interval 2s --health-start-period 5s \
  -v "$NAME-data:/data" \
  -e NODE_ENV=production \
  -e APP_PEPPER=smoke-pepper-not-a-real-secret-0000 \
  -e SESSION_KEY=smoke-session-key-not-a-real-secret \
  -e TRUST_PROXY=1 \
  -p "127.0.0.1:${PORT}:8080" \
  "$IMAGE" >/dev/null

step "wait for HEALTHCHECK"
for _ in $(seq 1 60); do
  status="$(dk inspect --format '{{.State.Health.Status}}' "$NAME" 2>/dev/null || echo missing)"
  [ "$status" = healthy ] && break
  [ "$(dk inspect --format '{{.State.Running}}' "$NAME" 2>/dev/null)" = true ] || fail "container exited"
  sleep 1
done
[ "$status" = healthy ] || fail "not healthy after 60s (status=$status)"

step "runs as non-root"
uid="$(dk exec "$NAME" node -e 'process.stdout.write(String(process.getuid()))')"
[ "$uid" != 0 ] || fail "container runs as root"

# code <expected> <curl args...>  -> asserts HTTP status, body saved to $TMP/body
code() {
  local want="$1"; shift
  local got
  got="$(curl -sS -o "$TMP/body" -w '%{http_code}' "$@")"
  [ "$got" = "$want" ] || { cat "$TMP/body" >&2; fail "expected $want got $got for: $*"; }
}

step "public endpoints"
code 200 "$BASE/healthz"
grep -q '"status":"ok"' "$TMP/body" || fail "/healthz body"
code 200 "$BASE/"
grep -q '<div id="root">' "$TMP/body" || fail "SPA index not served"
code 200 "$BASE/api/setup-needed"
grep -q '"needed":true' "$TMP/body" || fail "fresh DB should need setup"

step "auth gate"
code 401 "$BASE/api/me"
code 401 "$BASE/api/items"
code 401 "$BASE/media/1"

step "first-run setup (argon2id) -> __Host- session cookie"
curl -sS -D "$TMP/headers" -o "$TMP/body" -H 'content-type: application/json' \
  -d '{"username":"smoke","password":"smoke-password-123"}' "$BASE/api/auth/setup" >/dev/null
grep -qi '^set-cookie: __Host-storalex_sid=.*HttpOnly' "$TMP/headers" || fail "no hardened session cookie"
grep -qi '^set-cookie: .*Secure' "$TMP/headers" || fail "cookie not Secure"
grep -qi '^set-cookie: .*SameSite=Strict' "$TMP/headers" || fail "cookie not SameSite=Strict"
# Secure cookies are not replayed by curl over http, so send it explicitly.
COOKIE="$(grep -i '^set-cookie: __Host-storalex_sid=' "$TMP/headers" | sed -E 's/^[Ss]et-[Cc]ookie: ([^;]+);.*/\1/')"
code 200 -H "cookie: $COOKIE" "$BASE/api/me"
grep -q '"username":"smoke"' "$TMP/body" || fail "/api/me user"

step "login round-trip"
code 200 -H 'content-type: application/json' -d '{"username":"smoke","password":"smoke-password-123"}' "$BASE/api/auth/login"
code 401 -H 'content-type: application/json' -d '{"username":"smoke","password":"wrong-password"}' "$BASE/api/auth/login"

step "create place + item (node:sqlite writes to /data)"
code 201 -H "cookie: $COOKIE" -H 'content-type: application/json' -d '{"name":"Smoke unit"}' "$BASE/api/places"
code 200 -H "cookie: $COOKIE" "$BASE/api/places"
grep -q 'Smoke unit' "$TMP/body" || fail "place not listed"
dk exec "$NAME" test -s /data/storalex.db || fail "no DB file on the /data volume"

step "label PDF (pdf-lib + qrcode)"
code 200 -H "cookie: $COOKIE" -H 'content-type: application/json' -d '{"type":"item","count":3}' "$BASE/api/codes/print"
head -c 5 "$TMP/body" | grep -q '%PDF-' || fail "not a PDF"

step "photo upload (sharp native binary)"
# 1x1 PNG
printf '%s' 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==' \
  | base64 -d >"$TMP/pixel.png"
code 201 -H "cookie: $COOKIE" -F "file=@pixel.png;type=image/png" "$BASE/api/media"
photo_id="$(sed -E 's/.*"photo_id":([0-9]+).*/\1/' "$TMP/body")"
code 200 -H "cookie: $COOKIE" "$BASE/media/$photo_id"
printf 'not an image' >"$TMP/fake.png"
code 400 -H "cookie: $COOKIE" -F "file=@fake.png;type=image/png" "$BASE/api/media"

step "no error-level logs"
dk logs "$NAME" >"$TMP/container.log" 2>&1
# pino: level 50 = error, 60 = fatal
if grep -E '"level":(50|60)' "$TMP/container.log"; then fail "error-level log lines"; fi
if grep -Ei 'uncaught|unhandled|segmentation fault' "$TMP/container.log"; then fail "crash markers in logs"; fi

SMOKE_OK=1
echo "SMOKE OK ($IMAGE)"
