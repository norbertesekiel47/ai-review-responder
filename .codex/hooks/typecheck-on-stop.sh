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
  echo "codex typecheck-on-stop: ESLint SKIPPED — $MUTATION_SENTINEL is present." >&2
  echo "  A mutation is in progress. Remove the sentinel once the file is restored." >&2
  exit 0
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
