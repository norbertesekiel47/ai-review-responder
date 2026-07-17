#!/usr/bin/env bash
# .claude/hooks/stop-gate.sh
set -uo pipefail

INPUT=$(cat)

# Prevent infinite stop loops: if this hook already fired, let the stop pass.
[ "$(echo "$INPUT" | jq -r '.stop_hook_active // false')" = "true" ] && exit 0

INTAKE=".feature/intake.json"
STATUS=".feature/gate-status.json"

# Not in feature mode -> allow stop.
[ -f "$INTAKE" ] || exit 0

if [ ! -f "$STATUS" ]; then
  echo "Stop blocked: no gate evidence. Run scripts/verify-gate.sh (step 5) before finishing." >&2
  exit 2
fi

PASSED=$(jq -r '.passed // false' "$STATUS")
GATE_TS=$(jq -r '.timestamp // 0' "$STATUS")
HEAD_TS=$(git log -1 --format=%ct 2>/dev/null || echo 0)

if [ "$PASSED" != "true" ]; then
  FAILING=$(jq -r '[.checks[] | select(.result=="FAIL") | .name] | join(", ")' "$STATUS")
  echo "Stop blocked: verify gate is RED (failing: $FAILING). Fix and re-run scripts/verify-gate.sh." >&2
  exit 2
fi

if [ "$GATE_TS" -lt "$HEAD_TS" ]; then
  echo "Stop blocked: gate evidence is STALE (predates HEAD). Re-run scripts/verify-gate.sh after the latest commit." >&2
  exit 2
fi

exit 0
