#!/usr/bin/env bash
# Codex Stop hook for /feature gate evidence.
set -uo pipefail

INPUT=$(cat)
[ "$(jq -r '.stop_hook_active // false' <<<"$INPUT" 2>/dev/null || echo false)" = "true" ] && exit 0
HOOK_CWD=$(jq -r '.cwd // empty' <<<"$INPUT" 2>/dev/null || true)
[ -n "$HOOK_CWD" ] || HOOK_CWD="$PWD"
SESSION_ID=$(jq -r '.session_id // empty' <<<"$INPUT" 2>/dev/null || true)

list_candidates() {
  printf '%s\n' "$HOOK_CWD"
  git -C "$HOOK_CWD" worktree list --porcelain 2>/dev/null | sed -n 's/^worktree //p'
}

BLOCKED=0
while IFS= read -r ROOT; do
  [ -n "$ROOT" ] || continue
  [ -f "$ROOT/.feature/intake.json" ] || continue
  if [ "$ROOT" != "$HOOK_CWD" ]; then
    [ -n "$SESSION_ID" ] || continue
    grep -qxF "$SESSION_ID" "$ROOT/.feature/sessions" 2>/dev/null || continue
  fi
  STATUS="$ROOT/.feature/gate-status.json"
  if [ ! -f "$STATUS" ]; then
    echo "Stop blocked [$ROOT]: no gate evidence. Run scripts/verify-gate.sh first." >&2
    BLOCKED=1
    continue
  fi
  PASSED=$(jq -r '.passed // false' "$STATUS")
  GATE_TS=$(jq -r '.timestamp // 0' "$STATUS")
  HEAD_TS=$(git -C "$ROOT" log -1 --format=%ct 2>/dev/null || echo 0)
  if [ "$PASSED" != "true" ]; then
    FAILING=$(jq -r '[.checks[] | select(.result=="FAIL") | .name] | join(", ")' "$STATUS")
    echo "Stop blocked [$ROOT]: verify gate is RED (failing: $FAILING)." >&2
    BLOCKED=1
    continue
  fi
  if [ "$GATE_TS" -lt "$HEAD_TS" ]; then
    echo "Stop blocked [$ROOT]: gate evidence is stale. Re-run scripts/verify-gate.sh." >&2
    BLOCKED=1
  fi
done < <(list_candidates | sort -u)

[ "$BLOCKED" = 1 ] && exit 2
exit 0
