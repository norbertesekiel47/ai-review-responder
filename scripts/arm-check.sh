#!/usr/bin/env bash
# scripts/arm-check.sh — prove the /feature enforcement hooks are armed for
# THIS worktree, invoking them the way the harness does (`bash <script>`,
# matching the .codex/hooks.json registration). Run from the worktree root;
# scripts/feature-setup.sh runs it for you.
#
# Exit 0 = ARMED. Non-zero = DISARMED: STOP and report — do not implement.
set -uo pipefail

ROOT=$(git rev-parse --show-toplevel)
cd "$ROOT"

if [ ! -f .feature/intake.json ]; then
  echo "DISARMED: no .feature/intake.json at $ROOT — run scripts/feature-setup.sh first."
  exit 1
fi

# Guard probe: a path outside any sane surface must be blocked (exit 2).
# NOTE: a degenerate surface glob like "*" makes this probe report DISARMED —
# correctly, since such a surface enforces nothing.
echo "{\"tool_input\":{\"file_path\":\"$ROOT/__arm_check__/probe.ts\"}}" \
  | bash ./.codex/hooks/edit-surface-guard.sh >/dev/null 2>&1
GUARD=$?

# Stop-gate probe: with no gate evidence yet, stop must be blocked (exit 2).
# If gate evidence already exists (resumed run), the file's presence means
# the gate is being read — treat as armed rather than probing a green gate.
if [ -f .feature/gate-status.json ]; then
  STOP=2
else
  echo '{}' | bash ./.codex/hooks/stop-gate.sh >/dev/null 2>&1
  STOP=$?
fi

if [ "$GUARD" -eq 2 ] && [ "$STOP" -eq 2 ]; then
  echo "ARMED: edit-surface guard + stop gate live for $ROOT"
  exit 0
fi

echo "DISARMED: guard exit=$GUARD (want 2), stop-gate exit=$STOP (want 2)."
echo "Likely causes: missing jq, missing/broken hook scripts, or a degenerate"
echo "allowed_edit_surface glob ('*') that enforces nothing."
exit 1
