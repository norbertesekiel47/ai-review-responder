#!/usr/bin/env bash
# scripts/feature-state.sh — machine-readable /feature phase tracking.
#
#   bash scripts/feature-state.sh set-phase <phase>
#   bash scripts/feature-state.sh incr-round <plan|branch>
#   bash scripts/feature-state.sh incr-amendment [--reason "<owner-approved reason>"]
#   bash scripts/feature-state.sh incr-gate-round [--reason "<owner-approved reason>"]
#   bash scripts/feature-state.sh reset-gate-rounds
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
#
# incr-amendment: counts allowed_edit_surface amendments in the same durable
# place, and ENFORCES the abort criteria instead of narrating them — feat-898
# recorded "AMENDMENT 3 of 2" with the budget tracked only in prose. The 1st
# amendment passes; the 2nd and later refuse unless --reason records the
# owner's explicit sign-off (same shape as the ALLOW_DESTRUCTIVE_GIT escape).
#
# incr-gate-round: the gate-loop budget (speed lane build 3). Call it before
# each unattended execute→gate→fix iteration after a RED gate. Rounds 1-3
# pass; the 4th refuses without --reason — the "after 3 full gate-fail
# rounds, stop patching" abort criterion, enforced instead of narrated, so an
# unattended loop cannot thrash past its budget while nobody watches.
# reset-gate-rounds zeroes the counter after a green gate (a NEW red streak
# gets a fresh budget; one long-lived counter would refuse forever).
set -uo pipefail

COMMAND=${1:?usage: feature-state.sh set-phase <phase> | incr-round <plan|branch> | incr-amendment [--reason "..."]}

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

  incr-amendment)
    REASON=""
    if [ "${2:-}" = "--reason" ]; then
      REASON=${3:-}
      [ -n "$REASON" ] || { echo "incr-amendment: --reason needs a value"; exit 1; }
    elif [ -n "${2:-}" ]; then
      echo "usage: feature-state.sh incr-amendment [--reason \"<owner-approved reason>\"]"
      exit 1
    fi

    COUNT=$(printf '%s' "$PREV" | jq -r '.surfaceAmendments // 0')
    NEXT=$((COUNT + 1))
    if [ "$NEXT" -ge 2 ] && [ -z "$REASON" ]; then
      echo "feature-state: REFUSED — surface amendment ${NEXT} hits the abort criteria (2nd amendment of allowed_edit_surface)."
      echo "Stop and re-plan with the owner (feature.md step 5 abort criteria), or record their explicit sign-off:"
      echo "  bash scripts/feature-state.sh incr-amendment --reason \"<owner-approved reason>\""
      exit 1
    fi
    [ -n "$REASON" ] || REASON="auto-approved (1st amendment)"

    printf '%s' "$PREV" | jq --arg reason "$REASON" --arg now "$NOW" \
      '.surfaceAmendments = ((.surfaceAmendments // 0) + 1)
       | .surfaceAmendmentLog = ((.surfaceAmendmentLog // []) + [{n: .surfaceAmendments, reason: $reason, at: $now}])
       | .updatedAt = $now' \
      > .feature/state.json.tmp && mv .feature/state.json.tmp .feature/state.json

    echo "feature-state: surfaceAmendments=${NEXT} → .feature/state.json"
    ;;

  incr-gate-round)
    REASON=""
    if [ "${2:-}" = "--reason" ]; then
      REASON=${3:-}
      [ -n "$REASON" ] || { echo "incr-gate-round: --reason needs a value"; exit 1; }
    elif [ -n "${2:-}" ]; then
      echo "usage: feature-state.sh incr-gate-round [--reason \"<owner-approved reason>\"]"
      exit 1
    fi

    COUNT=$(printf '%s' "$PREV" | jq -r '.gateFailRounds // 0')
    NEXT=$((COUNT + 1))
    if [ "$NEXT" -ge 4 ] && [ -z "$REASON" ]; then
      echo "feature-state: REFUSED — gate-fail round ${NEXT} hits the abort criteria (3 full gate-fail rounds)."
      echo "Stop patching: run the diagnosing-bugs loop or re-plan with the owner. To continue anyway:"
      echo "  bash scripts/feature-state.sh incr-gate-round --reason \"<owner-approved reason>\""
      exit 1
    fi

    printf '%s' "$PREV" | jq --arg now "$NOW" \
      '.gateFailRounds = ((.gateFailRounds // 0) + 1) | .updatedAt = $now' \
      > .feature/state.json.tmp && mv .feature/state.json.tmp .feature/state.json

    echo "feature-state: gateFailRounds=${NEXT} → .feature/state.json"
    ;;

  reset-gate-rounds)
    printf '%s' "$PREV" | jq --arg now "$NOW" \
      '.gateFailRounds = 0 | .updatedAt = $now' \
      > .feature/state.json.tmp && mv .feature/state.json.tmp .feature/state.json
    echo "feature-state: gateFailRounds=0 → .feature/state.json"
    ;;

  *)
    echo "unknown command '$COMMAND' (set-phase | incr-round | incr-amendment | incr-gate-round | reset-gate-rounds)"
    exit 1
    ;;
esac
