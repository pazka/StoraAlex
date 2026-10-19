#!/usr/bin/env bash
# Container smoke test for the production image.
#
#   test/smoke/container-smoke.sh <image>
#
# Starts the image with the same hardening as docker-compose.yml (cap_drop ALL,
# no-new-privileges, non-root, /data volume, TRUST_PROXY=1, NODE_ENV=production),
# waits for the image's own HEALTHCHECK to report healthy, exercises real
# endpoints, checks the logs for errors, and checks a clean SIGTERM shutdown.
# Uses fake secrets only. Needs: docker, curl.
set -euo pipefail

IMAGE=${1:?usage: container-smoke.sh <image>}
NAME=storalex-smoke-$$
VOL=storalex-smoke-data-$$
PORT=${SMOKE_PORT:-18080}
BASE=http://127.0.0.1:$PORT
WORK=$(mktemp -d)

cleanup() {
  status=$?
  if [ $status -ne 0 ]; then
    echo "---- container logs ----"
    docker logs "$NAME" 2>&1 | tail -n 100 || true
  fi
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  docker volume rm "$VOL" >/dev/null 2>&1 || true
  rm -rf "$WORK"
  exit $status
}
trap cleanup EXIT

fail() { echo "SMOKE FAIL: $*" >&2; exit 1; }
pass() { echo "ok - $*"; }

# expect <code> <method> <path> [curl args...]: body -> $WORK/body, headers -> $WORK/headers
expect() {
  local want=$1 method=$2 path=$3; shift 3
  local got
  got=$(curl -sS -o "$WORK/body" -D "$WORK/headers" -w '%{http_code}' -X "$method" "$@" "$BASE$path")
  [ "$got" = "$want" ] || fail "$method $path -> $got (want $want): $(head -c 300 "$WORK/body")"
  pass "$method $path -> $got"
}

docker volume create "$VOL" >/dev/null
# --health-interval only shortens the polling period of the image's own
# HEALTHCHECK command (which is unchanged), so the job doesn't wait 30s.
docker run -d --name "$NAME" \
  --cap-drop ALL \
  --security-opt no-new-privileges:true \
  -e NODE_ENV=production \
  -e APP_PEPPER=smoke-test-fake-pepper-0123456789abcdef \
  -e SESSION_KEY=smoke-test-fake-session-key-0123456789 \
  -e TRUST_PROXY=1 \
  -v "$VOL":/data \
  -p "127.0.0.1:$PORT:8080" \
  --health-interval 2s \
  "$IMAGE" >/dev/null

echo "waiting for HEALTHCHECK..."
for _ in $(seq 1 60); do
  state=$(docker inspect -f '{{.State.Status}} {{.State.Health.Status}}' "$NAME")
  case "$state" in
    "running healthy") break ;;
    exited*|dead*) fail "container stopped: $state" ;;
  esac
  sleep 2
done
[ "$(docker inspect -f '{{.State.Health.Status}}' "$NAME")" = healthy ] || fail "never became healthy ($state)"
pass "HEALTHCHECK healthy"

# Runs as the unprivileged node user, with no capabilities.
[ "$(docker exec "$NAME" id -u)" = 1000 ] || fail "container does not run as uid 1000"
docker exec "$NAME" sh -c 'grep -q "^CapEff:[[:space:]]*0000000000000000$" /proc/1/status' || fail "process has effective capabilities"
pass "non-root, no effective capabilities"
# npm/npx were removed from the runtime image (see Dockerfile).
docker exec "$NAME" sh -c '! command -v npm && ! command -v npx' >/dev/null || fail "npm/npx present in runtime image"
pass "npm/npx absent"

# 1. health
expect 200 GET /healthz
grep -q '"status":"ok"' "$WORK/body" || fail "/healthz body"

# 2. PWA shell with the production CSP
expect 200 GET /
grep -q '<div id="root">' "$WORK/body" || fail "index.html not served"
grep -qi "^content-security-policy: .*script-src 'self'" "$WORK/headers" || fail "CSP header missing"

# 3. auth gate
expect 401 GET /api/items
expect 401 GET /media/1
expect 401 POST /api/codes/print -H 'content-type: application/json' --data '{"type":"item","count":1}'

# 4. first-run setup -> production session cookie
expect 200 GET /api/setup-needed
grep -q '"needed":true' "$WORK/body" || fail "setup-needed should be true on a fresh volume"
expect 201 POST /api/auth/setup -H 'content-type: application/json' --data '{"username":"smoke","password":"smoke-password-1"}'
cookie_line=$(grep -i '^set-cookie: __Host-storalex_sid=' "$WORK/headers" | tr -d '\r') || fail "no __Host- session cookie"
for attr in HttpOnly Secure SameSite=Strict 'Path=/'; do
  echo "$cookie_line" | grep -q "; $attr" || fail "cookie missing $attr: $cookie_line"
done
COOKIE=$(echo "$cookie_line" | sed -E 's/^[Ss]et-[Cc]ookie: ([^;]+);.*/\1/')
pass "session cookie flags"
expect 200 GET /api/me -H "cookie: $COOKIE"
grep -q '"username":"smoke"' "$WORK/body" || fail "/api/me user"

# 5. native deps in the runtime image: sharp (upload) and pdf-lib/qrcode (labels)
# 2x2 RGB PNG.
printf '%s' 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEklEQVQImWMwTjtjnHaGAUIBACS2BZUFBQd/AAAAAElFTkSuQmCC' | base64 -d > "$WORK/tiny.png"
expect 201 POST /api/media -H "cookie: $COOKIE" -F "file=@$WORK/tiny.png;type=image/png"
grep -q '"photo_id":1' "$WORK/body" || fail "upload body: $(cat "$WORK/body")"
expect 200 GET /media/1 -H "cookie: $COOKIE"
[ "$(dd if="$WORK/body" bs=1 skip=8 count=4 2>/dev/null)" = WEBP ] || fail "stored media is not WebP"
expect 200 POST /api/codes/print -H "cookie: $COOKIE" -H 'content-type: application/json' --data '{"type":"item","count":3}'
[ "$(head -c 5 "$WORK/body")" = "%PDF-" ] || fail "labels are not a PDF"

# 6. logs: JSON at info level, no error/fatal entries, nothing unexpected on stderr
docker logs "$NAME" >"$WORK/stdout" 2>"$WORK/stderr"
grep -q 'StorAlex listening on' "$WORK/stdout" || fail "no startup log line"
if grep -E '"level":(50|60)' "$WORK/stdout"; then fail "error/fatal entries in logs"; fi
if grep -vE 'ExperimentalWarning: SQLite|--trace-warnings|^\s*$' "$WORK/stderr"; then fail "unexpected stderr output"; fi
pass "logs clean"

# 7. graceful shutdown (SIGTERM handler -> exit 0)
docker stop -t 10 "$NAME" >/dev/null
[ "$(docker inspect -f '{{.State.ExitCode}}' "$NAME")" = 0 ] || fail "non-zero exit on SIGTERM"
pass "clean SIGTERM shutdown"

echo "container smoke test passed"
