#!/usr/bin/env bash
# scripts/feature-cleanup.sh — remove sibling worktrees whose PR has merged.
#
# The /feature step 8 cleanup, made mechanical (merged worktrees were
# accumulating with armed .feature/intake.json files because sessions end at
# merge). Squash merges make `git branch --merged` useless (CLAUDE.md), so
# merge status comes from `gh pr list --state merged`. A worktree is removed
# only when BOTH hold:
#   1. a merged PR exists for its branch, and
#   2. its tracked tree is clean (untracked files make `git worktree remove`
#      refuse on its own — surfaced, never forced).
# Default is a DRY RUN that prints the plan; pass --apply to execute.
# Removals stay one-at-a-time and never use --force.
set -uo pipefail

APPLY=false
[ "${1:-}" = "--apply" ] && APPLY=true

MAIN_ROOT=$(git rev-parse --show-toplevel)
CANDIDATES=0

while IFS= read -r WT; do
  [ "$WT" = "$MAIN_ROOT" ] && continue
  BRANCH=$(git -C "$WT" branch --show-current 2>/dev/null || true)
  if [ -z "$BRANCH" ]; then
    echo "SKIP   $WT — detached HEAD"
    continue
  fi
  case "$BRANCH" in
    main|staging)
      echo "SKIP   $WT — long-lived branch '$BRANCH'"
      continue
      ;;
  esac

  PR=$(gh pr list --head "$BRANCH" --state merged --json number --jq '.[0].number // empty' 2>/dev/null || true)
  if [ -z "$PR" ]; then
    echo "KEEP   $WT — no merged PR for '$BRANCH'"
    continue
  fi
  if [ -n "$(git -C "$WT" status --porcelain --untracked-files=no)" ]; then
    echo "KEEP   $WT — merged (PR #$PR) but tracked tree is DIRTY; inspect by hand"
    continue
  fi

  CANDIDATES=$((CANDIDATES + 1))
  if [ "$APPLY" = true ]; then
    echo "REMOVE $WT (branch '$BRANCH', merged PR #$PR)"
    git -C "$MAIN_ROOT" worktree remove "$WT" \
      && git -C "$MAIN_ROOT" branch -D "$BRANCH" \
      || echo "       ^ removal refused (untracked files?) — inspect by hand, never --force"
  else
    echo "WOULD REMOVE $WT (branch '$BRANCH', merged PR #$PR)"
  fi
done < <(
  while IFS= read -r -d '' REC; do
    case "$REC" in ("worktree "*) printf '%s\n' "${REC#worktree }" ;; esac
  done < <(git worktree list --porcelain -z 2>/dev/null)
)

if [ "$APPLY" = false ] && [ "$CANDIDATES" -gt 0 ]; then
  echo "Dry run: $CANDIDATES worktree(s) eligible — re-run with --apply to remove."
fi
