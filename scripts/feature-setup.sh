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
# 4. reports cross-worktree surface overlaps (scripts/feature-surface-check.sh).
set -uo pipefail

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

SLUG=$(printf '%s' "$BRANCH" | tr '/' '-')
DOCS_COPY="docs/superpowers/plans/${SLUG}-intake.json"
mkdir -p "$(dirname "$DOCS_COPY")" .feature
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

if ! bash scripts/feature-surface-check.sh; then
  echo "^ SURFACE OVERLAP above — surface it to the user before planning (step 3)."
fi
exit 0
