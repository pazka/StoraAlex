#!/usr/bin/env bash
# register-check.sh [DIR] [ENV_FILE] — what `hosh-deploy register storalex` checks on the box, run in CI
# against the repo (hosh-migration scripts/hosh-deploy do_register, copied; keep in sync).
#   DIR: checkout (default: repo root). ENV_FILE: env file to check (default: .env.example with
#   throwaway values for the `# required:` names, as the owner would fill them).
set -euo pipefail
DIR="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
die() { echo "REGISTER CHECK FAIL: $*" >&2; exit 1; }
KEYS="APP REPO DIR ENV_FILE SERVICE IMAGE_VAR IMAGE_REPO HOST BIND HEALTH POST_DEPLOY ROUTE COMPOSE_SHA256"
declare -A C
while IFS= read -r line || [ -n "$line" ]; do
  [[ "$line" =~ ^[[:space:]]*(#|$) ]] && continue
  [[ "$line" =~ ^([A-Z_0-9]+)=(.*)$ ]] || die "hosh-deploy.conf: bad line: $line"
  k="${BASH_REMATCH[1]}"; v="${BASH_REMATCH[2]}"
  v="${v#\'}"; v="${v%\'}"; v="${v#\"}"; v="${v%\"}"
  [[ " $KEYS " == *" $k "* ]] || die "hosh-deploy.conf: unknown key $k"
  C[$k]="$v"
done < "$DIR/deploy/hosh-deploy.conf"
for k in SERVICE IMAGE_VAR IMAGE_REPO ENV_FILE HOST BIND HEALTH; do [ -n "${C[$k]:-}" ] || die "config: $k is empty"; done
[[ "${C[IMAGE_REPO]}" =~ ^ghcr\.io/pazka/[a-z0-9._-]+$ ]] || die "IMAGE_REPO must be ghcr.io/pazka/<name>"
[[ "${C[BIND]}" =~ ^127\.0\.0\.1:[0-9]{2,5}$ ]] || die "BIND must be 127.0.0.1:<port>"
[[ "${C[HOST]}" =~ ^[a-z0-9.-]+$ ]] && [[ "${C[HEALTH]}" =~ ^/[A-Za-z0-9/_.-]*$ ]] && [[ "${C[IMAGE_VAR]}" =~ ^[A-Z][A-Z0-9_]*$ ]] || die "bad HOST/HEALTH/IMAGE_VAR"
grep -q "Host(\`\(@@HOST@@\|__HOST__\)\`)" "$DIR/deploy/traefik-route.yml.tmpl" || die "route template has no Host(@@HOST@@) rule"

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
cp "$DIR/docker-compose.example.yml" "$TMP/docker-compose.yml"
req="$(sed -n 's/^# required:[[:space:]]*//p' "$DIR/.env.example" | head -n1)"
[ -n "$req" ] || die ".env.example has no # required: line"
if [ -n "${2:-}" ]; then cp "$2" "$TMP/${C[ENV_FILE]}"; else
  cp "$DIR/.env.example" "$TMP/${C[ENV_FILE]}"
  for k in $req; do sed -i "s/^$k=.*/$k='register-check-placeholder-0000'/" "$TMP/${C[ENV_FILE]}"; done
fi
for k in $req; do
  [[ "$k" =~ ^[A-Z][A-Z0-9_]*$ ]] || die ".env.example # required: bad name '$k'"
  [ -n "$(sed -n "s/^$k=//p" "$TMP/${C[ENV_FILE]}" | tail -n1 | sed -e "s/^'\(.*\)'$/\1/" -e 's/^"\(.*\)"$/\1/')" ] || die "$k is empty"
  echo "  $k: present"
done
# the image line hosh-deploy rewrites must exist and point at IMAGE_REPO
grep -Eq "^${C[IMAGE_VAR]}='?${C[IMAGE_REPO]//./\\.}:v[0-9]+\.[0-9]+\.[0-9]+'?$" "$DIR/.env.example" || die ".env.example: no ${C[IMAGE_VAR]}=${C[IMAGE_REPO]}:vX.Y.Z line"
echo "-- compose hardening check"
docker compose --project-directory "$TMP" --env-file "$TMP/${C[ENV_FILE]}" -f "$TMP/docker-compose.yml" config --format json \
  | python3 -c '
import json, sys
svc, bind = sys.argv[1], sys.argv[2]
d = json.load(sys.stdin); bad = []
if svc not in d.get("services", {}): bad.append("service %s not in compose" % svc)
for name, s in d.get("services", {}).items():
    p = name + ": "
    u = str(s.get("user", "")).split(":")[0]
    if u in ("", "0", "root"): bad.append(p + "user must be non-root")
    if not s.get("read_only"): bad.append(p + "read_only: true required")
    if "ALL" not in (s.get("cap_drop") or []): bad.append(p + "cap_drop: [ALL] required")
    if s.get("cap_add"): bad.append(p + "cap_add not allowed")
    if not any(o.replace(" ", "") in ("no-new-privileges:true", "no-new-privileges") for o in (s.get("security_opt") or [])): bad.append(p + "no-new-privileges required")
    if s.get("privileged"): bad.append(p + "privileged not allowed")
    for k in ("network_mode", "pid", "ipc", "userns_mode", "uts"):
        if str(s.get(k, "")).startswith("host"): bad.append(p + k + ": host not allowed")
    if s.get("devices"): bad.append(p + "devices not allowed")
    for v in s.get("volumes") or []:
        if v.get("type") not in ("volume", "tmpfs"): bad.append(p + "only named volumes/tmpfs (got %s %s)" % (v.get("type"), v.get("source")))
    for pt in s.get("ports") or []:
        if pt.get("host_ip") not in ("127.0.0.1", "::1"): bad.append(p + "ports must bind 127.0.0.1")
        elif "%s:%s" % (pt.get("host_ip"), pt.get("published")) != bind: bad.append(p + "published %s:%s != BIND %s" % (pt.get("host_ip"), pt.get("published"), bind))
    if not s.get("healthcheck") or s["healthcheck"].get("disable"): bad.append(p + "healthcheck required")
print("\n".join("  ✗ " + b for b in bad) if bad else "  ✓ hardened (non-root, read-only, cap_drop ALL, no-new-privileges, no host access, loopback port, healthcheck)")
sys.exit(1 if bad else 0)' "${C[SERVICE]}" "${C[BIND]}" || die "compose does not meet the box standard"
echo "REGISTER CHECK OK (${C[SERVICE]} ${C[HOST]} ${C[BIND]})"
