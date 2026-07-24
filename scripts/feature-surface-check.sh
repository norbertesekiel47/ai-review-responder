#!/usr/bin/env bash
# scripts/feature-surface-check.sh — warn when two armed worktrees declare
# overlapping allowed_edit_surface globs. Parallel /feature runs editing the
# same area mean predictable merge conflicts and cross-branch coordination
# debt (see the fix-prod-hardening-guards deviations file for the failure
# mode this automates away).
#
# Usage: run from the newly armed worktree root (step 2, after the ARM
# CHECK). Compares this worktree's intake against every OTHER armed
# registered worktree. Overlap detection is a literal-prefix heuristic on
# the glob text — it flags candidates for human judgment, it does not prove
# overlap. Exit 2 on any code overlap so the orchestrator must surface it.
#
# Noise control (learned from the first live run — 32 raw hits, ~0 signal):
#   - process paths every feature touches are excluded (docs/**, CONTEXT.md,
#     .claude/**, .feature/**);
#   - test-only globs (containing __tests__ or .test.) are counted, not
#     listed — same-test-file collisions are real but rarely decision-worthy;
#   - detached-HEAD worktrees (fallow audit caches) are skipped. Merged-but-
#     not-cleaned worktrees still count: run scripts/feature-cleanup.sh first
#     for a clean signal.
set -uo pipefail

SELF_ROOT=$(git rev-parse --show-toplevel)
SELF_INTAKE="$SELF_ROOT/.feature/intake.json"
if [ ! -f "$SELF_INTAKE" ]; then
  echo "No $SELF_INTAKE — arm the worktree first (step 2)."
  exit 1
fi

# Literal prefix of a glob: everything before the first wildcard character.
prefix_of() { printf '%s' "$1" | sed 's/[*?[].*$//'; }

# Process artifacts every feature legitimately touches — not overlap signal.
is_process_glob() {
  case "$1" in
    docs/*|CONTEXT.md|.claude/*|.feature/*) return 0 ;;
  esac
  return 1
}

is_test_glob() {
  case "$1" in
    *__tests__*|*.test.*) return 0 ;;
  esac
  return 1
}

CODE_OVERLAPS=0
TEST_OVERLAPS=0
while IFS= read -r WT; do
  [ "$WT" = "$SELF_ROOT" ] && continue
  [ -f "$WT/.feature/intake.json" ] || continue
  [ -n "$(git -C "$WT" branch --show-current 2>/dev/null)" ] || continue

  while IFS= read -r THEIRS; do
    [ -n "$THEIRS" ] || continue
    is_process_glob "$THEIRS" && continue
    THEIR_PREFIX=$(prefix_of "$THEIRS")
    while IFS= read -r OURS; do
      [ -n "$OURS" ] || continue
      is_process_glob "$OURS" && continue
      OUR_PREFIX=$(prefix_of "$OURS")
      MATCH=0
      case "$OUR_PREFIX" in "$THEIR_PREFIX"*) MATCH=1 ;; esac
      case "$THEIR_PREFIX" in "$OUR_PREFIX"*) MATCH=1 ;; esac
      [ "$MATCH" = 1 ] || continue
      if is_test_glob "$OURS" || is_test_glob "$THEIRS"; then
        TEST_OVERLAPS=$((TEST_OVERLAPS + 1))
      else
        echo "OVERLAP: ours '$OURS' vs theirs '$THEIRS' in $WT"
        CODE_OVERLAPS=$((CODE_OVERLAPS + 1))
      fi
    done < <(jq -r '.allowed_edit_surface[]?' "$SELF_INTAKE")
  done < <(jq -r '.allowed_edit_surface[]?' "$WT/.feature/intake.json")
done < <(
  while IFS= read -r -d '' REC; do
    case "$REC" in ("worktree "*) printf '%s\n' "${REC#worktree }" ;; esac
  done < <(git worktree list --porcelain -z 2>/dev/null)
)

[ "$TEST_OVERLAPS" -gt 0 ] && echo "(test-glob overlaps not listed: $TEST_OVERLAPS)"

if [ "$CODE_OVERLAPS" -gt 0 ]; then
  echo "SURFACE OVERLAP: $CODE_OVERLAPS code pair(s) with other armed worktrees."
  echo "Coordinate before implementing — note the collision + agreed merge order"
  echo "in both deviations files, or narrow one surface."
  exit 2
fi
echo "No code-surface overlap with other armed worktrees."
