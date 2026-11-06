#!/usr/bin/env bash
# compose-smoke.sh MODE IMAGE  — run the BUILT image the way the box runs it, with docker compose,
# and prove full capability (not just a 200), including data surviving a container re-creation.
#
#   legacy    exactly the box's hand-made compose (/root/hosh-deploy/storalex, until the cutover):
#             image USER (node, uid 1000), port 8080 published on 127.0.0.1:8090, writable rootfs,
#             `.env` file, named volume at /data, Google service-account JSON bind-mounted read-only
#             at /run/secrets/google-sa.json, no-new-privileges, cap_drop ALL.
#   template  docker-compose.example.yml as hosh-deploy runs it (/srv/storalex): uid 10001, read-only
#             rootfs + tmpfs, PORT=8000 on 127.0.0.1:9138, storalex.env from .env.example (service
#             account as GOOGLE_SERVICE_ACCOUNT_JSON_B64), volume storalex-data. Also: the box's
#             `register` validation (scripts/register-check.sh) and POST_DEPLOY from
#             deploy/hosh-deploy.conf, exactly as hosh-deploy runs it (compose exec, argv).
#   cutover   DEPLOY.md "Cutover from legacy" end to end: legacy writes data → legacy stopped →
#             volume copied + chown 10001 (byte-identical) → env values moved → template serves the
#             same users/data/photos → rollback = legacy started again on its untouched volume.
#
# Every run: wait for the HEALTHCHECK → /healthz → SPA → first-run setup (argon2id + pepper)
# → place + item + photo (node:sqlite + sharp on the volume) → label PDF → Sheet mirror reads its
# credentials → `compose down` + `up` (new container, same volume) → login with the same password,
# same data, same photo bytes → no error-level logs.
#
# Throwaway fake secrets only. Needs: docker (compose v2), curl, python3, base64.
# Leaves nothing behind (containers, volumes, temp dir) unless KEEP=1.
set -euo pipefail

MODE="${1:?usage: compose-smoke.sh legacy|template|cutover IMAGE}"
IMAGE="${2:?usage: compose-smoke.sh MODE IMAGE}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d)"
PASSWORD='compose-smoke-password-123'
PEPPER=smoke-pepper-not-a-real-secret-0000
SKEY=smoke-session-key-not-a-real-secret
CONTAINER=storalex
LEGACY_VOLUME=storalex_storalex-data   # /root/hosh-deploy/storalex → compose project "storalex"
TEMPLATE_VOLUME=storalex-data          # pinned by docker-compose.example.yml
SIDE=

dk() { MSYS_NO_PATHCONV=1 docker "$@"; }
fail() { echo "COMPOSE SMOKE FAIL ($MODE${SIDE:+/$SIDE}): $*" >&2; exit 1; }
step() { echo "== [$MODE${SIDE:+/$SIDE}] $*"; }

case "$MODE" in legacy|template|cutover) ;; *) fail "unknown mode '$MODE' (legacy|template|cutover)" ;; esac

use_legacy() {
  PROJECT=storalex; VOLUME=$LEGACY_VOLUME; BASE=http://127.0.0.1:8090; WANT_UID=1000; SIDE=legacy
  COMPOSE_DIR="$WORK/storalex"; COMPOSE_ARGS=(-f docker-compose.yml)   # dir name = project, as on the box
}
use_template() {
  PROJECT=storalex; VOLUME=$TEMPLATE_VOLUME; BASE=http://127.0.0.1:9138; WANT_UID=10001; SIDE=template
  COMPOSE_DIR="$WORK/template"; COMPOSE_ARGS=(--env-file storalex.env -f docker-compose.yml)
}
compose() { (cd "$COMPOSE_DIR" && dk compose -p "$PROJECT" "${COMPOSE_ARGS[@]}" "$@"); }
up() { compose up -d --quiet-pull 2>&1 | grep -v -E '^\s*$' || true; }

cleanup() {
  local rc=$?
  if [ "$rc" != 0 ]; then
    echo "---- container log ----"; dk logs "$CONTAINER" 2>&1 | tail -n 80 || true
  fi
  if [ "${KEEP:-0}" != 1 ]; then
    for side in legacy template; do
      "use_$side"
      if [ -d "$COMPOSE_DIR" ]; then compose down --remove-orphans >/dev/null 2>&1 || true; fi
    done
    dk rm -f "$CONTAINER" >/dev/null 2>&1 || true
    dk volume rm -f "$LEGACY_VOLUME" "$TEMPLATE_VOLUME" >/dev/null 2>&1 || true
    rm -rf "$WORK"
  fi
}
trap cleanup EXIT

# A service-account JSON shaped like Google's (fake key: signing fails locally, nothing is sent).
fake_sa_json() {
  printf '%s' '{"type":"service_account","project_id":"smoke","private_key_id":"0","private_key":"-----BEGIN PRIVATE KEY-----\nbm90LWEta2V5\n-----END PRIVATE KEY-----\n","client_email":"smoke@smoke.iam.gserviceaccount.com","client_id":"0","token_uri":"https://oauth2.googleapis.com/token"}'
}

# envval NAME FILE: a value from a dotenv file (last one wins; one level of quotes removed)
envval() { sed -n "s/^$1=//p" "$2" | tail -n1 | sed -e "s/^'\(.*\)'$/\1/" -e 's/^"\(.*\)"$/\1/'; }
# setenv NAME VALUE FILE: replace (or append) NAME='VALUE'
setenv() {
  python3 -c '
import sys
k, v, f = sys.argv[1:]
lines = open(f).read().splitlines()
new = "%s=%s" % (k, "'"'"'" + v + "'"'"'")
if any(l.startswith(k + "=") for l in lines):
    lines = [new if l.startswith(k + "=") else l for l in lines]
else:
    lines.append(new)
open(f, "w").write("\n".join(lines) + "\n")' "$1" "$2" "$3"
}

write_legacy() {
  use_legacy
  mkdir -p "$COMPOSE_DIR/secrets"
  fake_sa_json >"$COMPOSE_DIR/secrets/google-sa.json"
  chmod 644 "$COMPOSE_DIR/secrets/google-sa.json"
  printf '%s\n' "APP_PEPPER=$PEPPER" "SESSION_KEY=$SKEY" TRUST_PROXY=1 DATA_DIR=/data \
    GOOGLE_SERVICE_ACCOUNT_JSON=/run/secrets/google-sa.json SHEET_ID=smoke-sheet-id \
    SHEET_SYNC_DEBOUNCE_MS=600000 >"$COMPOSE_DIR/.env"
  # The box's legacy compose, verbatim except the image reference.
  cat >"$COMPOSE_DIR/docker-compose.yml" <<EOF
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
}

# The box: /srv/storalex = release checkout; docker-compose.yml copied from the example by `register`;
# storalex.env = install -m 600 .env.example, then the owner's values (here: fakes, or the legacy ones).
write_template() {
  use_template
  mkdir -p "$COMPOSE_DIR"
  cp "$ROOT/docker-compose.example.yml" "$COMPOSE_DIR/docker-compose.yml"
  install -m 600 "$ROOT/.env.example" "$COMPOSE_DIR/storalex.env"
  local envf="$COMPOSE_DIR/storalex.env"
  setenv APP_IMAGE "$IMAGE" "$envf"
  if [ "$MODE" = cutover ]; then   # DEPLOY.md 1b C: values moved from the legacy container
    step "C: secrets moved from the legacy container (DEPLOY.md block, verbatim)"
    run_deploy_md_block env | tee "$WORK/env.log"
    grep -q 'moved into .*APP_PEPPER GOOGLE_SERVICE_ACCOUNT_JSON_B64 SESSION_KEY SHEET_ID SHEET_SYNC_DEBOUNCE_MS$' "$WORK/env.log" \
      || fail "env block did not move every value"
    if grep -q -e "$PEPPER" -e "$SKEY" "$WORK/env.log"; then fail "env block printed a secret"; fi
    [ "$(envval APP_PEPPER "$envf")" = "$PEPPER" ] || fail "APP_PEPPER not moved exactly"
    [ "$(stat -c %a "$envf")" = 600 ] || fail "storalex.env not 600"
  else
    setenv APP_PEPPER "$PEPPER" "$envf"; setenv SESSION_KEY "$SKEY" "$envf"
    setenv SHEET_ID smoke-sheet-id "$envf"; setenv SHEET_SYNC_DEBOUNCE_MS 600000 "$envf"
    setenv GOOGLE_SERVICE_ACCOUNT_JSON_B64 "$(fake_sa_json | base64 -w0)" "$envf"
  fi
}

register_check() {
  step "F: box register validation (hosh-deploy register, simulated)"
  bash "$ROOT/scripts/register-check.sh" "$ROOT" "$COMPOSE_DIR/storalex.env"
}

# run_deploy_md_block NAME: the ```sh block after "<!-- cutover:NAME" in DEPLOY.md, verbatim, with
# only the box paths pointed at this run's directories and `sudo` as a no-op.
run_deploy_md_block() {
  local f="$WORK/block-$1.sh"
  { echo 'set -uo pipefail'; echo 'sudo() { "$@"; }'; printf 'IMAGE=%q\n' "$IMAGE"
    awk -v m="<!-- cutover:$1" 'index($0, m) == 1 { f = 1; next } f && /^```sh$/ { g = 1; next } g && /^```$/ { exit } g { print }' "$ROOT/DEPLOY.md" \
      | sed -e "s#/root/hosh-deploy/storalex#$WORK/storalex#g" -e "s#/srv/storalex/storalex.env#$WORK/template/storalex.env#g"
  } >"$f"
  [ "$(wc -l <"$f")" -gt 5 ] || fail "DEPLOY.md block cutover:$1 not found"
  bash "$f"
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
  if [ "$SIDE" = template ]; then
    code 200 "$BASE/healthz"
    [ "$(json 'd["db"]+"/"+d["storage"]')" = ok/writable ] || fail "/healthz capability fields"
    [ "$(dk inspect -f '{{.HostConfig.ReadonlyRootfs}}' "$CONTAINER")" = true ] || fail "rootfs is writable"
    if dk exec "$CONTAINER" node -e "require('fs').writeFileSync('/app/x','x')" 2>/dev/null; then fail "wrote to /app"; fi
  fi
}

post_deploy() {  # exactly what hosh-deploy runs: POST_DEPLOY split on spaces, compose exec -T, no shell
  local line; line="$(sed -n 's/^POST_DEPLOY=//p' "$ROOT/deploy/hosh-deploy.conf")"
  [ -n "$line" ] || fail "POST_DEPLOY is empty"
  local -a pd; read -r -a pd <<< "$line"
  step "POST_DEPLOY: $line"
  compose exec -T storalex "${pd[@]}" || fail "POST_DEPLOY failed"
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

start_fresh() {
  step "start (fresh volume $VOLUME)"
  dk volume rm -f "$VOLUME" >/dev/null 2>&1 || true
  compose config --quiet || fail "compose file invalid"
  up
  common_checks
  code 200 "$BASE/api/setup-needed"
  [ "$(json 'd["needed"]')" = True ] || fail "fresh volume should need setup"
}

write_data() {
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
}

verify_data() {   # $1 = label for the place written afterwards
  step "same data after $1"
  code 200 "$BASE/api/setup-needed"
  [ "$(json 'd["needed"]')" = False ] || fail "setup needed again: DB lost"
  code 401 -H 'content-type: application/json' -d '{"username":"smoke","password":"wrong-password-123"}' "$BASE/api/auth/login"
  login login   # same password still verifies: same DB + same APP_PEPPER
  code 200 -H "cookie: $COOKIE" "$BASE/api/items/$ITEM"
  [ "$(json 'd["name"]')" = 'Compose smoke item' ] || fail "item lost"
  [ "$(json 'd["location_place_id"]')" = "$PLACE" ] || fail "item location lost"
  code 200 -H "cookie: $COOKIE" "$BASE/media/$PHOTO"
  [ "$(sha256sum "$WORK/body" | cut -d' ' -f1)" = "$PHOTO_SHA" ] || fail "photo bytes changed"
  code 201 -H "cookie: $COOKIE" -H 'content-type: application/json' -d "{\"name\":\"Written after $1\"}" "$BASE/api/places"
  code 201 -H "cookie: $COOKIE" -F "file=@$WORK/pixel.png;type=image/png" "$BASE/api/media"
  sheet_reads_credentials
}

recreate() {
  step "re-create the container (compose down + up, same volume)"
  compose down >/dev/null 2>&1
  dk volume inspect "$VOLUME" >/dev/null || fail "volume $VOLUME vanished"
  up
  common_checks
}

no_error_logs() {
  step "no error-level logs"
  dk logs "$CONTAINER" >"$WORK/container.log" 2>&1
  if grep -E '"level":(50|60)' "$WORK/container.log"; then fail "error-level log lines"; fi
  if grep -Ei 'uncaught|unhandled|segmentation fault' "$WORK/container.log"; then fail "crash markers in logs"; fi
}

# ---------------------------------------------------------------------------------------------
case "$MODE" in
  legacy|template)
    "write_$MODE"
    if [ "$MODE" = template ]; then register_check; fi
    start_fresh
    if [ "$MODE" = template ]; then post_deploy; fi
    write_data
    recreate
    verify_data "re-creation"
    if [ "$MODE" = template ]; then post_deploy; fi
    no_error_logs
    ;;
  cutover)
    write_legacy
    start_fresh
    write_data
    no_error_logs

    write_template   # B + C (env moved while legacy still runs, as in DEPLOY.md)

    step "D-E: stop legacy, copy the volume + chown 10001 (DEPLOY.md block, verbatim)"
    run_deploy_md_block copy | tee "$WORK/copy.log"
    if grep -q STOP "$WORK/copy.log"; then fail "copy block stopped"; fi
    grep -q 'legacy volume: storalex_storalex-data$' "$WORK/copy.log" || fail "legacy volume not found as on the box"
    grep -q ' ./storalex.db$' "$WORK/copy.log" || fail "storalex.db not in the copy"
    grep -q 'copy identical, owned by 10001:10001' "$WORK/copy.log" || fail "copy not verified"
    use_legacy
    [ "$(dk inspect -f '{{.State.Running}}' "$CONTAINER")" = false ] || fail "legacy still running"

    step "copy block refuses to run twice (storalex-data exists)"
    run_deploy_md_block copy | tee "$WORK/copy2.log"
    grep -q 'STOP: storalex-data already exists' "$WORK/copy2.log" || fail "second copy not refused"

    use_template
    register_check
    step "H-I: template compose on the copied volume"
    up
    common_checks
    post_deploy
    verify_data "cutover"
    no_error_logs

    step "rollback = template down, legacy up again on its untouched volume"
    compose down >/dev/null 2>&1
    use_legacy
    up
    common_checks
    login login
    code 200 -H "cookie: $COOKIE" "$BASE/api/items/$ITEM"
    code 200 -H "cookie: $COOKIE" "$BASE/api/places"
    grep -q 'Compose smoke unit' "$WORK/body" || fail "legacy data missing after rollback"
    if grep -q 'Written after cutover' "$WORK/body"; then fail "legacy volume was modified by the template run"; fi
    no_error_logs
    ;;
esac

echo "COMPOSE SMOKE OK ($MODE, $IMAGE)"
