#!/usr/bin/env bash
# scripts/gate-summary.sh — speed lane build 3: compact RED-gate report for
# the unattended gate loop. Prints ONLY the failing rows and the last N lines
# of each row's log, so a loop iteration consumes a briefing, not a log dump.
#
#   bash scripts/gate-summary.sh [--lines N]   # default 12
#
# Read-only. Exit 0 with "GATE: GREEN" when the last gate passed; exit 1 with
# the failure briefing when it failed; exit 2 when no gate has run.
set -uo pipefail

LINES=12
if [ "${1:-}" = "--lines" ]; then
  LINES=${2:-12}
fi

ROOT=$(git rev-parse --show-toplevel)
cd "$ROOT"

# The loop alternates full and fast runs, so the briefing must describe the
# run that JUST happened — read whichever result file is newer by its own
# recorded timestamp, never by file mtime (a fast run rewrites nothing else).
STATUS=""
NEWEST=-1
for CANDIDATE in .feature/gate-status.json .feature/gate-fast.json; do
  [ -f "$CANDIDATE" ] || continue
  TS_CANDIDATE=$(jq -r '.timestamp // 0' "$CANDIDATE" 2>/dev/null || echo 0)
  case "$TS_CANDIDATE" in ''|*[!0-9]*) TS_CANDIDATE=0 ;; esac
  if [ "$TS_CANDIDATE" -gt "$NEWEST" ]; then
    NEWEST=$TS_CANDIDATE
    STATUS="$CANDIDATE"
  fi
done
if [ -z "$STATUS" ]; then
  echo "gate-summary: no gate has run (.feature/gate-status.json missing) — run the gate first."
  exit 2
fi

PASSED=$(jq -r '.passed' "$STATUS")
MODE=$(jq -r '.mode // "full"' "$STATUS")
TS=$(jq -r '.timestamp // 0' "$STATUS")
AGE=$(( $(date +%s) - TS ))

if [ "$PASSED" = "true" ]; then
  echo "GATE: GREEN (mode ${MODE}, ${AGE}s ago) — nothing to fix."
  [ "$MODE" = "fast" ] && echo "  Fast green proves the fix, not the branch — run the full gate before review."
  exit 0
fi

FAILING=$(jq -r '.checks[] | select(.result == "FAIL") | .name' "$STATUS")
COUNT=$(printf '%s\n' "$FAILING" | grep -c . || true)
echo "GATE: RED (mode ${MODE}, ${AGE}s ago) — ${COUNT} failing row(s):"
echo

while IFS= read -r ROW; do
  [ -n "$ROW" ] || continue
  echo "=== ${ROW} ==="
  LOG=".feature/logs/${ROW}.log"
  if [ -f "$LOG" ]; then
    tail -n "$LINES" "$LOG"
  else
    echo "(no log at ${LOG})"
  fi
  echo
done <<< "$FAILING"

echo "Fix the rows above, then re-run:"
echo "  bash scripts/feature-state.sh incr-gate-round && bash scripts/verify-gate.sh --fast"
echo "Fast is for the loop only. Before review, run the full gate:"
echo "  bash .agents/skills/feature/scripts/verified-gate.sh --review"
exit 1
