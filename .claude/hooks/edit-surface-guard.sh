#!/usr/bin/env bash
# .claude/hooks/edit-surface-guard.sh
set -uo pipefail

INPUT=$(cat)
INTAKE=".feature/intake.json"

# Not in feature mode -> allow everything.
[ -f "$INTAKE" ] || exit 0

FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')
[ -n "$FILE_PATH" ] || exit 0

# Normalize to repo-relative path.
REL_PATH="${FILE_PATH#"$PWD"/}"

# --- Rule 1: dependency manifests need a justification file ---
case "$REL_PATH" in
  package.json|pnpm-lock.yaml|*/package.json)
    if [ ! -f ".feature/deps-justification.md" ]; then
      echo "BLOCKED: dependency manifest edit without .feature/deps-justification.md." >&2
      echo "Write that file first (reason, alternatives considered, blast radius)," >&2
      echo "get user sign-off, then retry." >&2
      exit 2
    fi
    ;;
esac

# --- Rule 2: path must match allowed_edit_surface (or always-allowed) ---
# Always allowed: process artifacts and docs.
case "$REL_PATH" in
  .feature/*|docs/*|CONTEXT.md) exit 0 ;;
esac

MATCHED=false
while IFS= read -r GLOB; do
  [ -n "$GLOB" ] || continue
  # [[ == ]] glob match; '*' crosses '/' here, so 'src/worker/*' matches
  # nested paths. Declare surfaces accordingly (e.g. "src/worker/*").
  # shellcheck disable=SC2254
  if [[ "$REL_PATH" == $GLOB ]]; then MATCHED=true; break; fi
done < <(jq -r '.allowed_edit_surface[]?' "$INTAKE")

if [ "$MATCHED" = false ]; then
  echo "BLOCKED: '$REL_PATH' is outside the intake contract's allowed_edit_surface." >&2
  echo "Either this edit is scope drift (re-plan), or the surface was declared" >&2
  echo "too narrowly (amend .feature/intake.json WITH user sign-off, then retry)." >&2
  exit 2
fi

exit 0
