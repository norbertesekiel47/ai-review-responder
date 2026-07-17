#!/usr/bin/env bash
# scripts/verify-gate.sh — the /feature step 5 gate.
#
# The audit set is derived from package.json's ci:* scripts (single
# authoritative owner — the same list CI's lint job and the lefthook
# pre-push gate run), so a gate-green branch can't fail push-time audits.
# ci:fallow* is excluded: the fallow gate runs in its own CI workflow with
# its own baseline and env expectations.
set -uo pipefail

INTAKE=".feature/intake.json"
mkdir -p .feature/logs

SURFACE=$(jq -r '.surface // "backend"' "$INTAKE" 2>/dev/null || echo "backend")

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

run lint      pnpm lint
run typecheck pnpm typecheck
run test      pnpm test

# Every ci:* audit from package.json (excluding ci:fallow*).
while IFS= read -r SCRIPT; do
  run "${SCRIPT#ci:}" pnpm "$SCRIPT"
done < <(jq -r '.scripts | keys[] | select(startswith("ci:")) | select(startswith("ci:fallow") | not)' package.json)

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
