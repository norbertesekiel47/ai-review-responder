#!/usr/bin/env bash
# Codex Stop hook: typecheck and lint changed TypeScript once per dirty state.
set -uo pipefail

ROOT=$(git rev-parse --show-toplevel 2>/dev/null || true)
[ -n "$ROOT" ] || exit 0
cd "$ROOT" || exit 0
jq -e '.scripts.typecheck' package.json >/dev/null 2>&1 || exit 0

INPUT=$(cat)
SESSION=$(jq -r '.session_id // "nosession"' <<<"$INPUT" 2>/dev/null || echo nosession)
DIRTY=$(git status --porcelain --untracked-files=all -- '*.ts' '*.tsx')
[ -n "$DIRTY" ] || exit 0

typescript_hash() {
  {
    git diff HEAD -- '*.ts' '*.tsx' || return 1
    git status --porcelain --untracked-files=all -- '*.ts' '*.tsx' || return 1
    while IFS= read -r -d '' FILE; do
      printf '%s\0' "$FILE"
      git hash-object -- "$FILE" 2>/dev/null || return 1
    done < <(git ls-files -z --others --exclude-standard -- '*.ts' '*.tsx')
  } | shasum -a 256 | cut -d' ' -f1
}

# A concurrent deletion during hashing is an unstable state, never a cache hit.
HASH=$(typescript_hash) || exit 0
CACHE_KEY=$(printf '%s\0%s' "$ROOT" "$SESSION" | shasum -a 256 | cut -d' ' -f1)
GREEN_STAMP="${TMPDIR:-/tmp}/codex-stop-typecheck-green-${CACHE_KEY}"
BLOCKED_STAMP="${TMPDIR:-/tmp}/codex-stop-typecheck-blocked-${CACHE_KEY}"
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

# Typecheck can take long enough for another task to remove or rename a file.
# Refresh the list now, retaining null delimiters and only existing paths.
LINTABLE=()
while IFS= read -r -d '' FILE; do
  [ ! -f "$FILE" ] || LINTABLE+=("$FILE")
done < <(
  git diff --name-only -z --diff-filter=ACMR HEAD -- '*.ts' '*.tsx'
  git ls-files -z --others --exclude-standard -- '*.ts' '*.tsx'
)
if [ "${#LINTABLE[@]}" -gt 0 ]; then
  # A deletion after enumeration must not masquerade as an ESLint finding.
  # The hash comparison below prevents an incomplete run from becoming green.
  LINT_OUT=$(pnpm exec eslint --no-error-on-unmatched-pattern "${LINTABLE[@]}" 2>&1)
  if [ $? -ne 0 ]; then
    printf '%s\n' "$HASH" > "$BLOCKED_STAMP"
    echo "ESLint failed on changed TypeScript files:" >&2
    printf '%s\n' "$LINT_OUT" | head -25 >&2
    exit 2
  fi
fi

FINAL_HASH=$(typescript_hash) || exit 0
if [ "$HASH" != "$FINAL_HASH" ]; then
  echo "codex typecheck-on-stop: files changed during verification; no green result cached." >&2
  exit 0
fi
printf '%s\n' "$HASH" > "$GREEN_STAMP"
exit 0
