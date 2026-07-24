#!/usr/bin/env bash
# scripts/feature-state.sh — machine-readable /feature phase tracking.
#
#   bash scripts/feature-state.sh set-phase <phase>
#
# Phases (forward-only by convention; the enum is the contract):
#   worktree_ready  plan_approved  executing  gate_green  reviewed  shipped
#
# Writes/merges .feature/state.json at the worktree root (ephemeral —
# gitignored with the rest of .feature/): version, branch, worktreePath,
# phase, baseSha, headSha, intakeSha256, lastGreenGateSha (snapshotted when
# phase=gate_green), updatedAt. /feature-resume reads this FIRST and
# cross-checks headSha + lastGreenGateSha against actual git state — prose
# handoff docs stay the human narrative; this file is the runner's truth.
set -uo pipefail

COMMAND=${1:?usage: feature-state.sh set-phase <phase>}
if [ "$COMMAND" != "set-phase" ]; then
  echo "unknown command '$COMMAND' (only: set-phase)"
  exit 1
fi
PHASE=${2:?usage: feature-state.sh set-phase <phase>}
case "$PHASE" in
  worktree_ready|plan_approved|executing|gate_green|reviewed|shipped) ;;
  *)
    echo "invalid phase '$PHASE' (worktree_ready|plan_approved|executing|gate_green|reviewed|shipped)"
    exit 1
    ;;
esac

ROOT=$(git rev-parse --show-toplevel)
cd "$ROOT"
BRANCH=$(git branch --show-current)
HEAD_SHA=$(git rev-parse HEAD)
BASE_SHA=$(git merge-base HEAD origin/main 2>/dev/null || echo "")
INTAKE_SHA=""
[ -f .feature/intake.json ] && INTAKE_SHA=$(shasum -a 256 .feature/intake.json | cut -d' ' -f1)
NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)

mkdir -p .feature
PREV="{}"
[ -f .feature/state.json ] && PREV=$(cat .feature/state.json)

LAST_GREEN=$(printf '%s' "$PREV" | jq -r '.lastGreenGateSha // empty' 2>/dev/null || echo "")
[ "$PHASE" = "gate_green" ] && LAST_GREEN="$HEAD_SHA"

printf '%s' "$PREV" | jq \
  --arg branch "$BRANCH" --arg wt "$ROOT" --arg phase "$PHASE" \
  --arg base "$BASE_SHA" --arg head "$HEAD_SHA" --arg intake "$INTAKE_SHA" \
  --arg green "$LAST_GREEN" --arg now "$NOW" \
  '. + {version: 1, branch: $branch, worktreePath: $wt, phase: $phase,
        baseSha: $base, headSha: $head, intakeSha256: $intake,
        updatedAt: $now}
   + (if $green != "" then {lastGreenGateSha: $green} else {} end)' \
  > .feature/state.json.tmp && mv .feature/state.json.tmp .feature/state.json

echo "feature-state: phase=$PHASE head=${HEAD_SHA:0:8} → .feature/state.json"
