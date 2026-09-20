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
#
# review-staging/ is where the review wave's axes write while a red-team
# mutation may be live. It sits inside gitignored .feature/ on purpose. Not
# because a checker rejects an untracked report — red-team-status.mjs reads
# porcelain with --untracked-files=no deliberately — but because red-team's
# post-restore assertion is AGENT judgement made while deciding whether a
# mutation was restored, and a sibling's file makes that call ambiguous. The
# root copies the reports into docs/reviews/ once the finalizer returns.
mkdir -p .feature/logs .feature/live .feature/review-staging

# The step ladder is required run state, not optional decoration — a run
# without .feature/progress.json reports progress from memory (the 1008 run
# shipped with no ladder and no live view). When missing, initialize it from
# the intake; feature-setup.sh — separately, and only when the parent's axes
# match and it is not older (see progress.mjs `carry`) — may replace this
# stub with the parent checkout's real orient/intake history. arm-check does
# not decide that carry, so it must not report an outcome it does not own.
#
# The intake is this run's sole authority for the stub's axes (#1107): a
# field that is absent, not a scalar, or outside its vocabulary now DISARMS
# instead of silently substituting a default. The silent substitution is what
# made #1107's misreported risk axis (`"risk": "high"` read back as `normal`)
# impossible to diagnose from the log — a run whose authority is unreadable
# must not arm.
PROGRESS_MJS=".agents/skills/feature/scripts/progress.mjs"
if [ ! -f .feature/progress.json ]; then
  if [ -f "$PROGRESS_MJS" ] && command -v node >/dev/null 2>&1; then
    # One jq pass emits all three axis values, risk/surface/size, one per line.
    # A string field comes back raw (the value to match); anything else comes
    # back as COMPACT JSON, so the DISARMED message below shows what was
    # actually there instead of a coerced-looking word. `classification` is an
    # older intake's spelling of the risk axis and is honoured only as a SCALAR
    # — an object (e.g. a stale carried-ladder shape) is out-of-vocabulary, not
    # a value to unwrap.
    AXES=$(jq -r 'def axis: if type == "string" then . else tojson end;
      (if (.risk | type) == "string" then .risk
       elif .risk == null and (.classification | type) == "string" then .classification
       else ((.risk // .classification) | tojson) end),
      (.surface | axis),
      (.size | axis)' .feature/intake.json)
    { IFS= read -r LADDER_RISK; IFS= read -r LADDER_SURFACE; IFS= read -r LADDER_SIZE; } <<<"$AXES"

    case "$LADDER_RISK" in
      normal|high) ;;
      *)
        echo "DISARMED: intake risk is $LADDER_RISK — expected one of normal|high"
        exit 1
        ;;
    esac

    case "$LADDER_SURFACE" in
      ui|backend|mixed) ;;
      *)
        echo "DISARMED: intake surface is $LADDER_SURFACE — expected one of ui|backend|mixed"
        exit 1
        ;;
    esac

    case "$LADDER_SIZE" in
      trivial|small|standard|epic) ;;
      *)
        echo "DISARMED: intake size is $LADDER_SIZE — expected one of trivial|small|standard|epic"
        exit 1
        ;;
    esac

    LADDER_RUNTIME=${FEATURE_RUNTIME:-${CODEX_THREAD_ID:+codex}}
    node "$PROGRESS_MJS" init --size "$LADDER_SIZE" --risk "$LADDER_RISK" --surface "$LADDER_SURFACE" --runtime "${LADDER_RUNTIME:-claude}" >/dev/null \
      && node "$PROGRESS_MJS" step intake done --note "ladder auto-initialized by arm-check" >/dev/null \
      && echo "ladder: .feature/progress.json initialized from the intake"
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
