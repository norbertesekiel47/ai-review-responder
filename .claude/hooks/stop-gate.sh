#!/usr/bin/env bash
# .claude/hooks/stop-gate.sh
#
# Stop gate for /feature runs: refuses to end the session while the verify
# gate is red, missing, or stale (older than HEAD).
#
# Arming is WORKTREE-SCAN + SESSION-BOUND: some harnesses (e.g. the VSCode
# extension) reset the shell cwd between Bash calls and fire hook processes
# anchored on the main checkout, while the feature lives in a sibling
# worktree. Worktree registration is the reliable link between the two, so
# the gate scans the hook's cwd, $CLAUDE_PROJECT_DIR, and every registered
# git worktree of either for an armed .feature/intake.json — but enforces
# only roots THIS session is engaged with: launched in it (cwd/project-dir
# match) or recorded in .feature/sessions by the edit-surface guard. Parked
# worktrees therefore never block unrelated sessions.
set -uo pipefail

INPUT=$(cat)

# Prevent infinite stop loops: if this hook already fired, let the stop pass.
[ "$(echo "$INPUT" | jq -r '.stop_hook_active // false')" = "true" ] && exit 0

SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // empty')

# Candidate roots that may be in feature mode.
list_candidates() {
  printf '%s\n' "$PWD"
  [ -n "${CLAUDE_PROJECT_DIR:-}" ] && printf '%s\n' "$CLAUDE_PROJECT_DIR"
  local BASE
  for BASE in "$PWD" "${CLAUDE_PROJECT_DIR:-}"; do
    [ -n "$BASE" ] || continue
    git -C "$BASE" worktree list --porcelain 2>/dev/null \
      | sed -n 's/^worktree //p'
  done
}

BLOCKED=0
while IFS= read -r ROOT; do
  [ -n "$ROOT" ] || continue
  [ -f "$ROOT/.feature/intake.json" ] || continue

  # Enforce only roots this session is engaged with: launched in it, or
  # recorded by the edit-surface guard's session binding.
  if [ "$ROOT" != "$PWD" ] && [ "$ROOT" != "${CLAUDE_PROJECT_DIR:-}" ]; then
    [ -n "$SESSION_ID" ] || continue
    grep -qxF "$SESSION_ID" "$ROOT/.feature/sessions" 2>/dev/null || continue
  fi

  STATUS="$ROOT/.feature/gate-status.json"
  if [ ! -f "$STATUS" ]; then
    echo "Stop blocked [$ROOT]: no gate evidence. Run scripts/verify-gate.sh from that worktree root (step 5) before finishing." >&2
    BLOCKED=1
    continue
  fi

  PASSED=$(jq -r '.passed // false' "$STATUS")
  GATE_TS=$(jq -r '.timestamp // 0' "$STATUS")
  HEAD_TS=$(git -C "$ROOT" log -1 --format=%ct 2>/dev/null || echo 0)

  if [ "$PASSED" != "true" ]; then
    FAILING=$(jq -r '[.checks[] | select(.result=="FAIL") | .name] | join(", ")' "$STATUS")
    echo "Stop blocked [$ROOT]: verify gate is RED (failing: $FAILING). Fix and re-run scripts/verify-gate.sh." >&2
    BLOCKED=1
    continue
  fi

  if [ "$GATE_TS" -lt "$HEAD_TS" ]; then
    echo "Stop blocked [$ROOT]: gate evidence is STALE (predates HEAD). Re-run scripts/verify-gate.sh after the latest commit." >&2
    BLOCKED=1
    continue
  fi
done < <(list_candidates | sort -u)

[ "$BLOCKED" = 1 ] && exit 2
exit 0
