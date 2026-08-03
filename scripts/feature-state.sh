#!/usr/bin/env bash
# scripts/feature-state.sh — machine-readable /feature phase tracking.
#
#   bash scripts/feature-state.sh set-phase <phase>
#   bash scripts/feature-state.sh incr-round <plan|branch>
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
#
# incr-round: increments planReviewRounds / branchReviewRounds and prints the
# new count. Review-round caps live in feature.md; the counter lives HERE so
# a resumed session continues the count instead of resetting to round 1 —
# uncounted rounds are how #628 reached a round-5 review under a "max 3" cap.
set -uo pipefail

COMMAND=${1:?usage: feature-state.sh set-phase <phase> | incr-round <plan|branch>}

ROOT=$(git rev-parse --show-toplevel)
cd "$ROOT"
mkdir -p .feature
PREV="{}"
[ -f .feature/state.json ] && PREV=$(cat .feature/state.json)
NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)

case "$COMMAND" in
  set-phase)
    PHASE=${2:?usage: feature-state.sh set-phase <phase>}
    case "$PHASE" in
      worktree_ready|plan_approved|executing|gate_green|reviewed|shipped) ;;
      *)
        echo "invalid phase '$PHASE' (worktree_ready|plan_approved|executing|gate_green|reviewed|shipped)"
        exit 1
        ;;
    esac

    BRANCH=$(git branch --show-current)
    HEAD_SHA=$(git rev-parse HEAD)
    BASE_SHA=$(git merge-base HEAD origin/main 2>/dev/null || echo "")
    INTAKE_SHA=""
    [ -f .feature/intake.json ] && INTAKE_SHA=$(shasum -a 256 .feature/intake.json | cut -d' ' -f1)

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
    ;;

  incr-round)
    KIND=${2:?usage: feature-state.sh incr-round <plan|branch>}
    case "$KIND" in
      plan) KEY="planReviewRounds" ;;
      branch) KEY="branchReviewRounds" ;;
      *)
        echo "invalid round kind '$KIND' (plan|branch)"
        exit 1
        ;;
    esac

    printf '%s' "$PREV" | jq --arg key "$KEY" --arg now "$NOW" \
      '.[$key] = ((.[$key] // 0) + 1) | .updatedAt = $now' \
      > .feature/state.json.tmp && mv .feature/state.json.tmp .feature/state.json

    COUNT=$(jq -r --arg key "$KEY" '.[$key]' .feature/state.json)
    echo "feature-state: ${KEY}=${COUNT} → .feature/state.json"
    ;;

  *)
    echo "unknown command '$COMMAND' (set-phase | incr-round)"
    exit 1
    ;;
esac
