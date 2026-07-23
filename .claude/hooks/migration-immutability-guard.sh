#!/usr/bin/env bash
# .claude/hooks/migration-immutability-guard.sh
#
# PreToolUse guard for Edit/Write/MultiEdit: applied migrations are immutable.
#
# RepWorth applies migrations to staging+prod in lockstep and records the
# applied head in .claude/reference/migrations-log.md ("Current head: **NNN**",
# updated in the same change as each migration). Editing a migration file at or
# below that head can never take effect — the fix is always a NEW numbered
# migration. This guard blocks such edits before they happen.
#
# The log is read from the edited file's OWN repo root (worktree-safe).
# Escape hatch for the rare legit case (e.g. amending an unapplied file after
# a premature log bump): MIGRATION_GUARD_DISABLE=1.
#
# Known gap (inherent to PreToolUse): edits routed through Bash (sed -i, >)
# never reach this guard.
set -uo pipefail

[ "${MIGRATION_GUARD_DISABLE:-0}" = "1" ] && exit 0

INPUT=$(cat)
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')
[ -n "$FILE_PATH" ] || exit 0

case "$FILE_PATH" in
  */supabase/migrations/*.sql) ;;
  *) exit 0 ;;
esac

BASE=$(basename "$FILE_PATH")
NUM=$(echo "$BASE" | sed -n 's/^\([0-9][0-9]*\)_.*/\1/p')
[ -n "$NUM" ] || exit 0

ANCHOR_DIR=$(dirname "$FILE_PATH")
while [ ! -d "$ANCHOR_DIR" ] && [ "$ANCHOR_DIR" != "/" ]; do
  ANCHOR_DIR=$(dirname "$ANCHOR_DIR")
done
ROOT=$(git -C "$ANCHOR_DIR" rev-parse --show-toplevel 2>/dev/null || true)
[ -n "$ROOT" ] || exit 0

LOG="$ROOT/.claude/reference/migrations-log.md"
[ -f "$LOG" ] || exit 0

HEAD_NUM=$(sed -n 's/^Current head: \*\*\([0-9][0-9]*\)\*\*.*/\1/p' "$LOG" | head -1)
[ -n "$HEAD_NUM" ] || exit 0

if [ "$((10#$NUM))" -le "$((10#$HEAD_NUM))" ]; then
  NEXT=$(printf '%03d' "$((10#$HEAD_NUM + 1))")
  echo "BLOCKED: $BASE is at or below the applied migration head ($HEAD_NUM per migrations-log.md)." >&2
  echo "Applied migrations are immutable — write a NEW migration (${NEXT}_*.sql) instead," >&2
  echo "and update migrations-log.md in the same change." >&2
  echo "Escape hatch if this file is genuinely unapplied: MIGRATION_GUARD_DISABLE=1." >&2
  exit 2
fi

exit 0
