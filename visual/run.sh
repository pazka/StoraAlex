#!/usr/bin/env bash
# Visual regression of the StorAlex PWA (hosh-management AGENTS.md §3, use cases in TESTING.md "Visual use cases").
# Pattern of pazka/lbgca, pazka/DrawTogether and pazka/MyMurderParty visual/:
#   visual/run.sh [IMAGE] [--update]          (default storalex:smoke)
# 1. starts the image as docker-compose.example.yml runs it (uid 10001, read-only rootfs, tmpfs /tmp, cap_drop ALL,
#    no-new-privileges, pids/memory limits, PORT=8000, DATA_DIR=/data on a FRESH volume, NODE_ENV=production,
#    TRUST_PROXY of .env.example, throwaway fake secrets, Google Sheet unconfigured), published on 127.0.0.1 only;
# 2. starts two headless Chromes on the runner (mouse / touch; every host name but localhost resolves to nothing);
# 3. runs visual/shoot.mjs with the image's own node (built-in fetch/WebSocket/http, no package), same hardening:
#    it makes the first account and the fixed data through the API, then Chrome opens http://localhost:<port>/…
#    for every use case at 1400 / 1024 / 390, compared with visual/baseline/. Shots, diffs, report.json: $OUT.
#   CHROME=/path/to/chrome (default google-chrome)   OUT=visual/out   VISUAL_PRINT_NEW=1 (CI: failing shots
#   printed in the log, visual/from-log.mjs writes them back as files)   ONLY=SC (cases starting with SC)
#   --update: overwrite the baselines (QA only, in a PR that says why).
# New baselines (QA, in a PR that says the change is wanted): take them from the CI artifact (or the CI log with
# visual/from-log.mjs), made by the runner's Chrome, look at every picture, commit them.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"
IMAGE="${1:-storalex:smoke}"
[ $# -gt 0 ] && shift
OUT="${OUT:-visual/out}"
NAME="storalex-visual-$$"
VOL="storalex-visual-$$"
PORT=18138
CDP_DESKTOP=9381
CDP_PHONE=9382
P1="$(mktemp -d)"; P2="$(mktemp -d)"
LOGS="$(mktemp -d)"
PIDS=()
dk() { MSYS_NO_PATHCONV=1 docker "$@"; }
cleanup() {
  for p in "${PIDS[@]}"; do kill "$p" 2>/dev/null || true; done
  dk rm -f "$NAME" >/dev/null 2>&1 || true
  dk volume rm -f "$VOL" >/dev/null 2>&1 || true
  rm -rf "$P1" "$P2" "$LOGS"
  return 0
}
trap cleanup EXIT
fail() { echo "VISUAL FAIL: $*" >&2; exit 1; }

# 1. the app as docker-compose.example.yml runs it (values of that file and .env.example, by hand: no env file)
dk volume create "$VOL" >/dev/null
dk run -d --name "$NAME" \
  --user 10001:10001 --read-only --tmpfs /tmp:size=16m,mode=1777 --cap-drop ALL \
  --security-opt no-new-privileges:true --pids-limit 128 --memory 512m \
  -e PORT=8000 -e DATA_DIR=/data -e NODE_ENV=production \
  -e TRUST_PROXY='127.0.0.0/8,::1/128,172.16.0.0/12' \
  -e APP_PEPPER=visual-pepper-not-a-real-secret-00 -e SESSION_KEY=visual-session-key-not-a-real-secret \
  -v "$VOL:/data" -p "127.0.0.1:$PORT:8000" "$IMAGE" >/dev/null
for _ in $(seq 1 60); do
  curl -fsS "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1 && break
  sleep 0.5
done
curl -fsS "http://127.0.0.1:$PORT/healthz" >/dev/null || { dk logs "$NAME" >"$LOGS/app.log" 2>&1 || true; tail -40 "$LOGS/app.log" >&2; fail "app not healthy"; }
test "$(dk exec "$NAME" node -e 'process.stdout.write(String(process.getuid()))')" = 10001 || fail "app does not run as 10001"
dk exec "$NAME" sh -c 'touch /rootfs-probe' 2>/dev/null && fail "rootfs is writable"
curl -fsS "http://127.0.0.1:$PORT/api/setup-needed" | grep -q '"needed":true' || fail "the instance is not fresh"

# 2. the Chromes
RULES="MAP * ~NOTFOUND, EXCLUDE localhost"  # = visual/cdp.mjs RESOLVER_RULES
COMMON=(--headless=new --no-sandbox --disable-gpu --mute-audio --no-first-run --hide-scrollbars
  --force-color-profile=srgb --font-render-hinting=none --disable-features=Translate,MediaRouter
  --disable-background-networking --lang=en-US "--host-resolver-rules=$RULES")
LANG=en_US.UTF-8 "${CHROME:-google-chrome}" "${COMMON[@]}" \
  --blink-settings=primaryHoverType=2,availableHoverTypes=2,primaryPointerType=4,availablePointerTypes=4 \
  --remote-debugging-port=$CDP_DESKTOP --user-data-dir="$P1" about:blank >"$LOGS/chrome1.log" 2>&1 &
PIDS+=($!)
LANG=en_US.UTF-8 "${CHROME:-google-chrome}" "${COMMON[@]}" \
  --remote-debugging-port=$CDP_PHONE --user-data-dir="$P2" about:blank >"$LOGS/chrome2.log" 2>&1 &
PIDS+=($!)
for port in $CDP_DESKTOP $CDP_PHONE; do
  for _ in $(seq 1 120); do curl -fsS "http://127.0.0.1:$port/json/version" >/dev/null 2>&1 && break; sleep 0.5; done
  curl -fsS "http://127.0.0.1:$port/json/version" >/dev/null 2>&1 || {
    tail -30 "$LOGS/chrome1.log" "$LOGS/chrome2.log" >&2
    fail "Chrome (${CHROME:-google-chrome}) has no DevTools endpoint on 127.0.0.1:$port"; }
done

# 3. the shots (the image's own node, hardened the same way; host network = the Chromes and the app on loopback)
rm -rf "$OUT"; mkdir -p "$OUT"; chmod 777 "$OUT"
BASE_MOUNT=(-v "$ROOT/visual:/v:ro")
for a in "$@"; do
  if [ "$a" = --update ]; then mkdir -p visual/baseline; BASE_MOUNT+=(-v "$ROOT/visual/baseline:/v/baseline"); chmod 777 visual/baseline; fi
done
set +e
dk run --rm --network host --user 10001:10001 --read-only --cap-drop ALL --security-opt no-new-privileges:true \
  -e CDP_DESKTOP=$CDP_DESKTOP -e CDP_PHONE=$CDP_PHONE -e OUT=/out -e BASELINE=/v/baseline/ \
  -e VISUAL_PRINT_NEW="${VISUAL_PRINT_NEW:-}" -e ONLY="${ONLY:-}" \
  "${BASE_MOUNT[@]}" -v "$ROOT/$OUT:/out" --entrypoint node "$IMAGE" \
  /v/shoot.mjs "http://localhost:$PORT" "$@"
rc=$?
set -e
# logs to a file first: under pipefail a pipe into grep -q can lose the match (SIGPIPE) and hide an error
dk logs "$NAME" >"$LOGS/app.log" 2>&1 || true
# pino levels: 50 = error, 60 = fatal
if grep -qE '"level":(50|60)' "$LOGS/app.log"; then
  echo "VISUAL FAIL: the app logged an error" >&2
  grep -E '"level":(50|60)' "$LOGS/app.log" | head -20 >&2
  rc=1
fi
cp "$LOGS/app.log" "$OUT/server.log" 2>/dev/null || true
exit $rc
