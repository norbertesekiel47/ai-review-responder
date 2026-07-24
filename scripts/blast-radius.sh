#!/usr/bin/env bash
# scripts/blast-radius.sh — list the importers of every changed production
# source file, so step 7 reviews see caller-side blast radius instead of
# only the diff (typecheck catches signature breaks; it cannot catch a
# semantic change whose callers relied on the old behavior).
#
# Heuristic import-text search: the `@/…` alias for src/ files plus a
# `from '…/<basename>'` match for relative imports. It locates candidate
# callers for a human/agent to judge — it does not prove impact.
#
# Writes docs/reviews/<branch>/blast-radius.md (committed with the branch,
# handed to the spec & correctness agent as input).
set -uo pipefail

ROOT=$(git rev-parse --show-toplevel)
cd "$ROOT"
BRANCH=$(git branch --show-current)
[ -n "$BRANCH" ] || { echo "detached HEAD — run from the feature worktree"; exit 1; }
SLUG=$(printf '%s' "$BRANCH" | tr '/' '-')
BASE=$(git merge-base HEAD origin/main)
OUT="docs/reviews/${SLUG}/blast-radius.md"
mkdir -p "$(dirname "$OUT")"

CHANGED=$(
  {
    git diff --name-only "$BASE"
    git status --porcelain --untracked-files=all | cut -c4-
  } | sort -u | grep -E '^(src|worker)/.*\.(ts|tsx)$' | grep -vE '__tests__|\.test\.' || true
)

{
  echo "# Blast radius — importers of changed files (\`$BRANCH\`)"
  echo
  echo "Heuristic import-text search; verify semantic impact per caller."
  echo
  if [ -z "$CHANGED" ]; then
    echo "_No changed production source files._"
  fi
  while IFS= read -r FILE; do
    [ -n "$FILE" ] || continue
    NOEXT="${FILE%.tsx}"; NOEXT="${NOEXT%.ts}"; NOEXT="${NOEXT%/index}"
    NAME=$(basename "$NOEXT")
    ALIAS=""
    case "$FILE" in src/*) ALIAS="@/${NOEXT#src/}" ;; esac
    # grep, not rg: rg is unavailable to child bash processes in this
    # environment (interactive-shell-only install).
    IMPORTERS=$(
      {
        [ -n "$ALIAS" ] && grep -rlF "'$ALIAS'" --include='*.ts' --include='*.tsx' src worker scripts 2>/dev/null
        [ -n "$ALIAS" ] && grep -rlF "\"$ALIAS\"" --include='*.ts' --include='*.tsx' src worker scripts 2>/dev/null
        grep -rlE "from ['\"][^'\"]*/${NAME}(\.js)?['\"]" --include='*.ts' --include='*.tsx' src worker scripts 2>/dev/null
      } | sort -u | grep -v "^${FILE}\$" || true
    )
    COUNT=$(printf '%s' "$IMPORTERS" | grep -c . || true)
    echo "## \`$FILE\` — ${COUNT} importer(s)"
    if [ -n "$IMPORTERS" ]; then
      printf '%s\n' "$IMPORTERS" | sed 's/^/- /'
    else
      echo "_none found (entry point, or dynamic/config-driven usage — check registration sites)_"
    fi
    echo
  done <<< "$CHANGED"
} > "$OUT"

echo "wrote $OUT"
