#!/usr/bin/env bash
# .claude/hooks/stop-gate.sh
#
# Stop gate for /feature runs: refuses to end the session while the verify
# gate is red, missing, or stale (older than HEAD). Arms from the session cwd
# first, then $CLAUDE_PROJECT_DIR, so a stray `cd` away from the worktree at
# stop time doesn't silently disarm it. feature.md additionally pins the
# session cwd to the worktree root for the whole run (CWD PIN rule).
set -uo pipefail

INPUT=$(cat)

# Prevent infinite stop loops: if this hook already fired, let the stop pass.
[ "$(echo "$INPUT" | jq -r '.stop_hook_active // false')" = "true" ] && exit 0

ROOT=""
for CANDIDATE in "$PWD" "${CLAUDE_PROJECT_DIR:-}"; do
  if [ -n "$CANDIDATE" ] && [ -f "$CANDIDATE/.feature/intake.json" ]; then
    ROOT="$CANDIDATE"
    break
  fi
done

# Not in feature mode -> allow stop.
[ -n "$ROOT" ] || exit 0

STATUS="$ROOT/.feature/gate-status.json"

if [ ! -f "$STATUS" ]; then
  echo "Stop blocked: no gate evidence. Run scripts/verify-gate.sh (step 5) before finishing." >&2
  exit 2
fi

PASSED=$(jq -r '.passed // false' "$STATUS")
GATE_TS=$(jq -r '.timestamp // 0' "$STATUS")
HEAD_TS=$(git -C "$ROOT" log -1 --format=%ct 2>/dev/null || echo 0)

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
