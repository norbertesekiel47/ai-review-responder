#!/usr/bin/env bash
# Codex Stop hook: typecheck and lint changed TypeScript once per dirty state.
set -u

ROOT=$(git rev-parse --show-toplevel 2>/dev/null || true)
[ -n "$ROOT" ] || exit 0
cd "$ROOT" || exit 0
jq -e '.scripts.typecheck' package.json >/dev/null 2>&1 || exit 0

INPUT=$(cat)
SESSION=$(jq -r '.session_id // "nosession"' <<<"$INPUT" 2>/dev/null || echo nosession)
DIRTY=$(git status --porcelain --untracked-files=all -- '*.ts' '*.tsx')
[ -n "$DIRTY" ] || exit 0

# Deleted files still require a project typecheck, but ESLint can only receive
# paths that remain in the worktree. Include untracked files explicitly because
# they are not part of `git diff --name-only` yet.
CHANGED=$(
  {
    git diff --name-only --diff-filter=ACMR HEAD -- '*.ts' '*.tsx'
    git ls-files --others --exclude-standard -- '*.ts' '*.tsx'
  } | LC_ALL=C sort -u
)

HASH=$( { git diff HEAD -- '*.ts' '*.tsx'; printf '%s\n' "$DIRTY" | cksum; } | cksum | cut -d' ' -f1 )
GREEN_STAMP="/tmp/codex-stop-typecheck-green-${SESSION}"
BLOCKED_STAMP="/tmp/codex-stop-typecheck-blocked-${SESSION}"
[ -f "$GREEN_STAMP" ] && [ "$(cat "$GREEN_STAMP")" = "$HASH" ] && exit 0
[ -f "$BLOCKED_STAMP" ] && [ "$(cat "$BLOCKED_STAMP")" = "$HASH" ] && exit 0

TSC_OUT=$(pnpm typecheck 2>&1)
if [ $? -ne 0 ]; then
  printf '%s\n' "$HASH" > "$BLOCKED_STAMP"
  echo "Typecheck failed on the current TypeScript changes:" >&2
  printf '%s\n' "$TSC_OUT" | grep -E 'error TS' | head -25 >&2
  exit 2
fi

if [ -n "$CHANGED" ]; then
  LINT_OUT=$(printf '%s\n' "$CHANGED" | tr '\n' '\0' | xargs -0 pnpm exec eslint 2>&1)
  if [ $? -ne 0 ]; then
    printf '%s\n' "$HASH" > "$BLOCKED_STAMP"
    echo "ESLint failed on changed TypeScript files:" >&2
    printf '%s\n' "$LINT_OUT" | head -25 >&2
    exit 2
  fi
fi

printf '%s\n' "$HASH" > "$GREEN_STAMP"
exit 0
