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

# Bootstrap (2026-08-29 skill hardening): four runs across six weeks failed on
# a missing .feature/ path (logs/, progress.json). The full tree is created
# here, so a resumed or hand-armed worktree self-heals instead of failing at
# step 5 with "no such file or directory".
mkdir -p .feature/logs .feature/live

# The step ladder is required run state, not optional decoration — a run
# without .feature/progress.json reports progress from memory (the 1008 run
# shipped with no ladder and no live view). When missing, initialize it from
# the intake; feature-setup.sh carries the parent checkout's ladder over this
# stub when one exists (the parent copy has the real orient/intake history).
PROGRESS_MJS=".agents/skills/feature/scripts/progress.mjs"
if [ ! -f .feature/progress.json ]; then
  if [ -f "$PROGRESS_MJS" ] && command -v node >/dev/null 2>&1; then
    LADDER_RISK=$(jq -r '.classification // "normal"' .feature/intake.json)
    [ "$LADDER_RISK" = "high" ] || LADDER_RISK="normal"
    LADDER_SURFACE=$(jq -r '.surface // "backend"' .feature/intake.json)
    case "$LADDER_SURFACE" in ui|backend|mixed) ;; *) LADDER_SURFACE="backend" ;; esac
    LADDER_SIZE=$(jq -r '.size // "standard"' .feature/intake.json)
    case "$LADDER_SIZE" in trivial|small|standard|epic) ;; *) LADDER_SIZE="standard" ;; esac
    node "$PROGRESS_MJS" init --size "$LADDER_SIZE" --risk "$LADDER_RISK" --surface "$LADDER_SURFACE" >/dev/null \
      && node "$PROGRESS_MJS" step intake done --note "ladder auto-initialized by arm-check" >/dev/null \
      && echo "ladder: .feature/progress.json initialized from the intake (no parent ladder carried)"
  else
    echo "DISARMED: no .feature/progress.json and the ladder scripts are unavailable — carry or init the step ladder first (see .agents/skills/feature/references/progress-and-live-view.md)."
    exit 1
  fi
fi

# Surface spelling (#867): a pre-escaped bracket ('\[id\]', '[[]id[]]') in
# allowed_edit_surface matches NOTHING in either hook or ci:feature-surface —
# the matchers escape '[' ']' themselves — so the guard is NOT armed for that
# path: it blocks writes the intake explicitly lists, which reads as "surface
# declared too narrowly" and invites a spurious amendment. feature-setup.sh
# refuses this before commit; this re-check covers resumed and amended runs.
BAD_SPELLINGS=$(jq -r '.allowed_edit_surface[]? | select(test("\\\\\\[|\\\\\\]|\\[\\[\\]|\\[\\]\\]"))' .feature/intake.json)
if [ -n "$BAD_SPELLINGS" ]; then
  echo "DISARMED: allowed_edit_surface pre-escapes a bracket — the hooks cannot match these entries. Write the PLAIN path (e.g. src/app/api/u/[token]/route.ts) in BOTH intake copies:"
  printf '%s\n' "$BAD_SPELLINGS" | sed 's/^/  - /'
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
  # Keep the ladder true: an ARMED report and a pending `armed` step cannot
  # both be right. Idempotent — re-marking a done step only refreshes its note.
  [ -f "$PROGRESS_MJS" ] && command -v node >/dev/null 2>&1 \
    && node "$PROGRESS_MJS" step armed done --note "ARMED" >/dev/null 2>&1
  echo "ARMED: edit-surface guard + stop gate live for $ROOT"
  exit 0
fi

echo "DISARMED: guard exit=$GUARD (want 2), stop-gate exit=$STOP (want 2)."
echo "Likely causes: missing jq, missing/broken hook scripts, or a degenerate"
echo "allowed_edit_surface glob ('*') that enforces nothing."
exit 1
