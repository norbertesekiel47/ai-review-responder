#!/usr/bin/env bash
# scripts/verify-gate.sh
set -uo pipefail

INTAKE=".feature/intake.json"
mkdir -p .feature/logs
: > .feature/logs/.gitkeep

SURFACE=$(jq -r '.surface // "backend"' "$INTAKE" 2>/dev/null || echo "backend")
DB=$(jq -r '.db_touching // false' "$INTAKE" 2>/dev/null || echo "false")

NAMES=()
RESULTS=()

run() {
  local name="$1"; shift
  if "$@" > ".feature/logs/${name}.log" 2>&1; then
    NAMES+=("$name"); RESULTS+=("PASS")
  else
    NAMES+=("$name"); RESULTS+=("FAIL")
  fi
}

run lint             pnpm lint
run typecheck        pnpm typecheck
run test             pnpm test
run static-policy    pnpm ci:static-policy
run analytics-events pnpm ci:analytics-events

if [ "$DB" = "true" ]; then
  run tenant-scope pnpm ci:tenant-scope
  run rls-audit    pnpm ci:rls-audit
fi

if [ "$SURFACE" = "ui" ] || [ "$SURFACE" = "mixed" ]; then
  run build pnpm build
fi

# Extra commands declared in the intake (each entry is one shell command).
while IFS= read -r CMD; do
  [ -n "$CMD" ] || continue
  SAFE=$(echo "$CMD" | tr -c 'a-zA-Z0-9' '-' | cut -c1-40)
  run "extra-${SAFE}" bash -c "$CMD"
done < <(jq -r '.verification_commands[]?' "$INTAKE" 2>/dev/null)

PASSED=true
CHECKS_JSON="["
for i in "${!NAMES[@]}"; do
  [ "${RESULTS[$i]}" = "FAIL" ] && PASSED=false
  CHECKS_JSON+="{\"name\":\"${NAMES[$i]}\",\"result\":\"${RESULTS[$i]}\"},"
done
CHECKS_JSON="${CHECKS_JSON%,}]"

printf '{"passed":%s,"timestamp":%s,"checks":%s}\n' \
  "$PASSED" "$(date +%s)" "$CHECKS_JSON" > .feature/gate-status.json

echo "VERIFY GATE:"
for i in "${!NAMES[@]}"; do
  printf '  %-24s %s\n' "${NAMES[$i]}" "${RESULTS[$i]}"
done

if [ "$PASSED" = "true" ]; then
  echo "GATE: GREEN"
  exit 0
else
  echo "GATE: RED — tails in .feature/logs/<name>.log"
  exit 1
fi
