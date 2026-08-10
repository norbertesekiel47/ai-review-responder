#!/bin/bash
# Stop hook: run typecheck + eslint over changed TS files before a turn ends,
# so strict-mode errors bounce back into the same session instead of surfacing
# as a separate remediation round (or a failed pre-push).
#
# Self-limiting by design: each distinct dirty-tree state is checked once.
# A failing state blocks the stop ONCE (exit 2 feeds errors back to Claude);
# if the same state tries to stop again, it passes through — no infinite loops,
# no nagging about pre-existing WIP the agent didn't touch.
set -u

ROOT="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null)}"
[ -z "$ROOT" ] && exit 0
cd "$ROOT" || exit 0

# Worktrees poison lint/typecheck here (parent node_modules leakage) — skip.
case "$ROOT" in *"/.claude/worktrees/"*) exit 0 ;; esac

# Only fire when the repo actually has the scripts this hook runs.
jq -e '.scripts.typecheck' package.json >/dev/null 2>&1 || exit 0

INPUT=$(cat)
SESSION=$(echo "$INPUT" | jq -r '.session_id // "nosession"' 2>/dev/null || echo "nosession")

CHANGED=$(git status --porcelain | cut -c4- | grep -E '\.(ts|tsx)$' || true)
[ -z "$CHANGED" ] && exit 0

# Fingerprint the current TS dirty state (tracked diffs + untracked contents).
HASH=$( { git diff HEAD -- '*.ts' '*.tsx'; echo "$CHANGED" | tr '\n' '\0' | xargs -0 cksum 2>/dev/null; } | cksum | cut -d' ' -f1 )
GREEN_STAMP="/tmp/stop-typecheck-green-${SESSION}"
BLOCKED_STAMP="/tmp/stop-typecheck-blocked-${SESSION}"
[ -f "$GREEN_STAMP" ] && [ "$(cat "$GREEN_STAMP")" = "$HASH" ] && exit 0
[ -f "$BLOCKED_STAMP" ] && [ "$(cat "$BLOCKED_STAMP")" = "$HASH" ] && exit 0

TSC_OUT=$(pnpm typecheck 2>&1)
if [ $? -ne 0 ]; then
  echo "$HASH" > "$BLOCKED_STAMP"
  {
    echo "typecheck failed on the current changes — fix these before finishing the turn:"
    echo "$TSC_OUT" | grep -E "error TS" | head -25
  } >&2
  exit 2
fi

# Deleted (and rename-mangled "old -> new") paths can't be linted — ESLint
# errors "No files matching the pattern" and exits non-zero. Pass ESLint only
# paths that still exist on disk; the typecheck above already covers deletions.
LINTABLE=$(echo "$CHANGED" | while IFS= read -r f; do [ -n "$f" ] && [ -f "$f" ] && printf '%s\n' "$f"; done)
if [ -n "$LINTABLE" ]; then
  LINT_OUT=$(echo "$LINTABLE" | tr '\n' '\0' | xargs -0 pnpm exec eslint 2>&1)
  if [ $? -ne 0 ]; then
    echo "$HASH" > "$BLOCKED_STAMP"
    {
      echo "eslint failed on changed files — fix before finishing the turn:"
      echo "$LINT_OUT" | head -25
    } >&2
    exit 2
  fi
fi

echo "$HASH" > "$GREEN_STAMP"
exit 0
