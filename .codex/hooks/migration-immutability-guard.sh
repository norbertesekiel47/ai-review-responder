#!/usr/bin/env bash
# Codex PreToolUse guard for applied migration immutability.
set -uo pipefail
[ "${MIGRATION_GUARD_DISABLE:-0}" = "1" ] && exit 0

INPUT=$(cat)
HOOK_CWD=$(jq -r '.cwd // empty' <<<"$INPUT" 2>/dev/null || true)
[ -n "$HOOK_CWD" ] || HOOK_CWD="$PWD"
TOOL_NAME=$(jq -r '.tool_name // empty' <<<"$INPUT" 2>/dev/null || true)
COMMAND=$(jq -r '.tool_input.command // empty' <<<"$INPUT" 2>/dev/null || true)

if [ "$TOOL_NAME" = "apply_patch" ]; then
  PATHS=$(printf '%s\n' "$COMMAND" | sed -n -E -e 's/^\*\*\* (Add|Update|Delete) File: ?//p' -e 's/^\*\*\* Move to: ?//p')
elif [ -n "$COMMAND" ]; then
  PATHS=$(printf '%s\n' "$COMMAND" | grep -oE 'supabase/migrations/[0-9]+_[A-Za-z0-9_.-]+\.sql' || true)
else
  PATHS=$(jq -r '.tool_input.file_path // empty' <<<"$INPUT" 2>/dev/null || true)
fi

while IFS= read -r FILE_PATH; do
  [ -n "$FILE_PATH" ] || continue
  FILE_PATH=$(python3 -c 'from pathlib import Path; import sys; print((Path(sys.argv[1]) / sys.argv[2]).resolve())' "$HOOK_CWD" "$FILE_PATH") || exit 2
  case "$FILE_PATH" in
    */supabase/migrations/*.sql|supabase/migrations/*.sql) ;;
    *) continue ;;
  esac
  BASE=$(basename "$FILE_PATH")
  NUM=$(printf '%s\n' "$BASE" | sed -n 's/^\([0-9][0-9]*\)_.*/\1/p')
  [ -n "$NUM" ] || continue
  ANCHOR=$(dirname "$FILE_PATH")
  while [ ! -d "$ANCHOR" ] && [ "$ANCHOR" != "/" ]; do ANCHOR=$(dirname "$ANCHOR"); done
  ROOT=$(git -C "$ANCHOR" rev-parse --show-toplevel 2>/dev/null || true)
  [ -n "$ROOT" ] || continue
  LOG="$ROOT/.claude/reference/migrations-log.md"
  if [ ! -f "$LOG" ]; then
    echo "BLOCKED: authoritative migration log is missing: $LOG" >&2
    exit 2
  fi
  HEAD_NUM=$(sed -n 's/^Current head: \*\*\([0-9][0-9]*\)\*\*.*/\1/p' "$LOG" | head -1)
  if [ -z "$HEAD_NUM" ]; then
    echo "BLOCKED: could not read the applied migration head from $LOG" >&2
    exit 2
  fi
  if [ "$((10#$NUM))" -le "$((10#$HEAD_NUM))" ]; then
    NEXT=$(printf '%03d' "$((10#$HEAD_NUM + 1))")
    echo "BLOCKED: $BASE is at or below the applied migration head ($HEAD_NUM)." >&2
    echo "Write a new migration (${NEXT}_*.sql) instead." >&2
    exit 2
  fi
done <<<"$PATHS"

exit 0
