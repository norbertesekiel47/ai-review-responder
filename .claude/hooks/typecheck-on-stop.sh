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

# MUTATION SENTINEL (#896 part 2). A guard-integrity pass DELETES a guard on
# purpose and runs the suite to see whether anything catches it. ESLint then
# reports the now-orphaned import, and the mechanically obvious remedy —
# delete the unused import — PERMANENTLY REMOVES a posting precondition
# (invariant #3). It happened: the 2026-08-18 pass held invariant #3's
# auto-policy conjunct deleted at worker/jobs/publisher/auto-policy-publish.ts
# and this hook demanded the import be cleaned up before the turn could end.
#
# A lint-on-stop hook cannot tell a measurement from a mistake, so the agent
# running one declares itself:
#
#     touch .feature/mutation-in-progress     # already git-ignored
#     ... mutate, run the suite, RESTORE the file ...
#     rm .feature/mutation-in-progress
#
# TYPECHECK STILL RUNS. tsconfig sets no `noUnusedLocals`, so tsc cannot
# produce the dangerous finding, and a real type break during a mutation is
# still worth hearing about (deleting a union member is caught that way).
# Only the eslint block is skipped, and NO green stamp is written on that
# path — the state is unverified, not verified.
MUTATION_SENTINEL="$ROOT/.feature/mutation-in-progress"
if [ -f "$MUTATION_SENTINEL" ]; then
  echo "typecheck-on-stop: eslint SKIPPED — $MUTATION_SENTINEL is present." >&2
  echo "  A mutation is in progress. Remove the sentinel once the file is restored." >&2
  exit 0
fi

# Deleted (and rename-mangled "old -> new") paths can't be linted — ESLint
# errors "No files matching the pattern" and exits non-zero. Pass ESLint only
# paths that still exist on disk; the typecheck above already covers deletions.
LINTABLE=$(echo "$CHANGED" | while IFS= read -r f; do [ -n "$f" ] && [ -f "$f" ] && printf '%s\n' "$f"; done)
if [ -n "$LINTABLE" ]; then
  # --cache: ESLint's cold start dominates a one-file lint (measured 1.7 s cold,
  # 0.7 s cached). The cache lives under node_modules and is never committed.
  LINT_OUT=$(echo "$LINTABLE" | tr '\n' '\0' | xargs -0 pnpm exec eslint --cache --cache-location node_modules/.cache/eslint/ 2>&1)
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
