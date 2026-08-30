#!/usr/bin/env bash
# scripts/feature-setup.sh — /feature step 2, made mechanical.
# Run from the NEW worktree root (created by `pnpm worktree:new <branch>`):
#
#   bash scripts/feature-setup.sh <path-to-locked-intake.json>
#
# 1. installs the intake contract twice: a COMMITTED audit-trail copy at
#    docs/superpowers/plans/<branch>-intake.json, and the ephemeral arming
#    copy at .feature/intake.json (gitignored BY DESIGN — a committed
#    .feature/ intake would follow the merge onto main and arm every future
#    main session; see #512);
# 2. deletes the parent-checkout draft (one authoritative owner);
# 3. proves enforcement is armed (scripts/arm-check.sh);
# 4. reports cross-worktree surface overlaps (scripts/feature-surface-check.sh);
# 5. initializes .feature/state.json (phase=worktree_ready) via
#    scripts/feature-state.sh — the machine-readable phase record
#    /feature-resume reads first.
set -uo pipefail

# Preflight: every tool the workflow's hooks/scripts require, checked up
# front with an actionable error instead of a mid-run 127.
for BIN in git jq pnpm shasum grep node; do
  command -v "$BIN" >/dev/null 2>&1 || {
    echo "PREFLIGHT FAILED: required tool '$BIN' not found on PATH — install it before arming."
    exit 1
  }
done

SRC=${1:?usage: feature-setup.sh <path-to-locked-intake.json>}
ROOT=$(git rev-parse --show-toplevel)
cd "$ROOT"

BRANCH=$(git branch --show-current)
if [ -z "$BRANCH" ]; then
  echo "detached HEAD — run from the feature worktree, not a temp checkout."
  exit 1
fi
case "$BRANCH" in
  main|staging)
    echo "refusing to arm long-lived branch '$BRANCH' — run from the feature worktree."
    exit 1
    ;;
esac

if ! jq -e . "$SRC" >/dev/null 2>&1; then
  echo "intake is not valid JSON: $SRC"
  exit 1
fi

# Surface spelling (#867): brackets are ALWAYS literal in an allowed_edit_surface
# glob — both edit-surface-guard hooks and ci:feature-surface escape them
# themselves at match time — so a pre-escaped Next.js dynamic segment
# ('\[id\]', '[[]id[]]') matches NOTHING anywhere: the hook blocks writes to a
# path the intake explicitly lists, and the audit goes red at PR time. Refuse
# BEFORE anything is committed. Same predicate as scripts/arm-check.sh.
BAD_SPELLINGS=$(jq -r '.allowed_edit_surface[]? | select(test("\\\\\\[|\\\\\\]|\\[\\[\\]|\\[\\]\\]"))' "$SRC")
if [ -n "$BAD_SPELLINGS" ]; then
  echo "intake allowed_edit_surface pre-escapes a bracket — write the PLAIN path (e.g. src/app/api/u/[token]/route.ts):"
  printf '%s\n' "$BAD_SPELLINGS" | sed 's/^/  - /'
  echo "The hooks and ci:feature-surface escape '[' ']' themselves; a pre-escaped entry matches nothing (#867)."
  exit 1
fi

SLUG=$(printf '%s' "$BRANCH" | tr '/' '-')
DOCS_COPY="docs/superpowers/plans/${SLUG}-intake.json"
mkdir -p "$(dirname "$DOCS_COPY")" .feature/logs .feature/live
cp "$SRC" "$DOCS_COPY"
cp "$SRC" .feature/intake.json

# Remove the parent draft only after both copies exist — and only when it is
# actually a different file than the docs copy we just wrote.
SRC_ABS=$(cd "$(dirname "$SRC")" && pwd)/$(basename "$SRC")
[ "$SRC_ABS" != "$ROOT/$DOCS_COPY" ] && rm -f "$SRC_ABS"

git add "$DOCS_COPY"
git commit -q -m "chore(feature): intake contract for ${BRANCH}" -- "$DOCS_COPY"
echo "intake installed: $DOCS_COPY (committed) + .feature/intake.json (arming copy)"

bash scripts/arm-check.sh || exit 1

# Carry the parent checkout's step ladder into the armed worktree (steps 0–1
# ran there). arm-check auto-initialized a stub when none existed; the parent
# ladder, when present, replaces the stub with the real orient/intake history.
# Best effort: a failed carry leaves the stub, never blocks arming.
PARENT_ROOT=$(git worktree list --porcelain | awk '/^worktree /{print $2; exit}')
if [ -n "$PARENT_ROOT" ] && [ "$PARENT_ROOT" != "$ROOT" ] \
   && [ -f "$PARENT_ROOT/.feature/progress.json" ]; then
  node .agents/skills/feature/scripts/progress.mjs carry "$PARENT_ROOT" \
    || echo "ladder: carry from $PARENT_ROOT failed — keeping the auto-initialized stub."
fi

bash scripts/feature-state.sh set-phase worktree_ready

if ! bash scripts/feature-surface-check.sh; then
  echo "^ SURFACE OVERLAP above — surface it to the user before planning (step 3)."
fi
exit 0
