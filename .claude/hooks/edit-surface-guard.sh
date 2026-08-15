#!/usr/bin/env bash
# .claude/hooks/edit-surface-guard.sh
#
# PreToolUse guard for Edit/Write/MultiEdit during a /feature run.
#
# Arming is FILE-ANCHORED: the guard resolves the edited file's own repo root
# and looks for .feature/intake.json there, falling back to the session cwd.
# This survives session `cd` drift — a worktree edit is enforced even when the
# hook process fires from the parent checkout, and an armed session cannot
# write into a different checkout (the "edit silently lands in main's tree"
# footgun from CLAUDE.md).
#
# Known gap (inherent to PreToolUse): file changes made through Bash
# (`sed -i`, `>` redirects, `mv`) never reach this guard. feature.md bans
# routing repo edits through Bash during a feature run.
set -uo pipefail

INPUT=$(cat)

FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')
[ -n "$FILE_PATH" ] || exit 0

# Absolute path (the harness normally passes absolute; belt-and-braces).
case "$FILE_PATH" in
  /*) ABS_PATH="$FILE_PATH" ;;
  *)  ABS_PATH="$PWD/$FILE_PATH" ;;
esac

# Repo root the edit actually targets: git root of the nearest EXISTING
# ancestor (the file itself may not exist yet for a Write into a new dir).
ANCHOR_DIR=$(dirname "$ABS_PATH")
while [ ! -d "$ANCHOR_DIR" ] && [ "$ANCHOR_DIR" != "/" ]; do
  ANCHOR_DIR=$(dirname "$ANCHOR_DIR")
done
TARGET_ROOT=$(git -C "$ANCHOR_DIR" rev-parse --show-toplevel 2>/dev/null || true)

# --- Always-on worktree containment (independent of /feature arming) ---
# When this session's cwd is inside a WORKTREE checkout (sibling
# …-worktrees/<branch>/ or nested .claude/worktrees/), an edit that targets a
# different checkout is almost always the "edit silently lands in main's tree"
# footgun (CLAUDE.md worktree rules). The reverse direction — editing a
# worktree from the main checkout — stays allowed (that's the blessed flow).
# Files outside any git repo (scratchpad, /tmp) are unaffected.
if [ "${WORKTREE_EDIT_GUARD_DISABLE:-0}" != "1" ]; then
  SESSION_ROOT=$(git -C "$PWD" rev-parse --show-toplevel 2>/dev/null || true)
  case "$SESSION_ROOT" in
    *-worktrees/*|*/.claude/worktrees/*|*/.worktrees/*)
      if [ -n "$TARGET_ROOT" ] && [ "$TARGET_ROOT" != "$SESSION_ROOT" ]; then
        echo "BLOCKED: session cwd is worktree '$SESSION_ROOT' but the edit targets '$TARGET_ROOT'." >&2
        echo "Point the Write/Edit path at the worktree root — an edit to another checkout" >&2
        echo "silently lands in that tree. If cross-checkout editing is genuinely intended," >&2
        echo "set WORKTREE_EDIT_GUARD_DISABLE=1." >&2
        exit 2
      fi
      ;;
  esac
fi

# Arm from the target repo root first, the session cwd second.
ROOT=""
if [ -n "$TARGET_ROOT" ] && [ -f "$TARGET_ROOT/.feature/intake.json" ]; then
  ROOT="$TARGET_ROOT"
elif [ -f "$PWD/.feature/intake.json" ]; then
  ROOT="$PWD"
fi

# Not in feature mode anywhere relevant -> allow everything.
[ -n "$ROOT" ] || exit 0

INTAKE="$ROOT/.feature/intake.json"

# Armed, but the edit targets a DIFFERENT git checkout (parent repo, another
# worktree): always a mistake mid-feature — the edit would land in the wrong
# tree regardless of what the surface globs say.
if [ -n "$TARGET_ROOT" ] && [ "$TARGET_ROOT" != "$ROOT" ]; then
  echo "BLOCKED: edit targets checkout '$TARGET_ROOT' but the feature is armed in '$ROOT'." >&2
  echo "Mid-feature edits must stay inside the feature worktree — an edit to another" >&2
  echo "checkout silently lands in that tree (see CLAUDE.md worktree rules)." >&2
  exit 2
fi

# Armed, and the file lives outside ANY git repo (scratchpad, /tmp notes):
# not repo code — allow.
[ -z "$TARGET_ROOT" ] && exit 0

# Session binding: record that THIS session is working the armed worktree,
# so the stop gate (which may fire from a different cwd) enforces the gate
# for engaged sessions only — parked worktrees don't nag unrelated sessions.
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // empty')
if [ -n "$SESSION_ID" ]; then
  SESSIONS_FILE="$ROOT/.feature/sessions"
  grep -qxF "$SESSION_ID" "$SESSIONS_FILE" 2>/dev/null \
    || echo "$SESSION_ID" >> "$SESSIONS_FILE"
fi

REL_PATH="${ABS_PATH#"$ROOT"/}"

# --- Rule 1: dependency manifests need a justification file ---
case "$REL_PATH" in
  package.json|pnpm-lock.yaml|*/package.json)
    if [ ! -f "$ROOT/.feature/deps-justification.md" ]; then
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
  # Escape '[' and ']' so a Next.js dynamic route segment is matched LITERALLY.
  # Without this, `[[ "$p" == $GLOB ]]` reads the '[id]' in a declared surface
  # like 'src/app/admin/businesses/[id]/**' as a bash CHARACTER CLASS matching
  # one char ('i' or 'd'), so the glob can never match the real directory and
  # the guard blocks writes to paths the intake explicitly lists. Every dynamic
  # segment in this repo hit it: [id], [reviewId], [token], [responseId],
  # [sessionId], [offboardingId], [escalationId], [businessId].
  #
  # Escaping only the brackets keeps '*' and '?' working as wildcards, so every
  # existing surface declaration behaves exactly as before. Character classes in
  # a surface glob are NOT supported (no declaration uses one, and a literal
  # dynamic-route segment is the overwhelmingly more likely intent).
  ESCAPED_GLOB="${GLOB//\[/\\[}"
  ESCAPED_GLOB="${ESCAPED_GLOB//\]/\\]}"
  # [[ == ]] glob match; '*' crosses '/' here, so 'src/worker/*' matches
  # nested paths. Declare surfaces accordingly (e.g. "src/worker/*").
  # shellcheck disable=SC2254
  if [[ "$REL_PATH" == $ESCAPED_GLOB ]]; then MATCHED=true; break; fi
done < <(jq -r '.allowed_edit_surface[]?' "$INTAKE")

if [ "$MATCHED" = false ]; then
  echo "BLOCKED: '$REL_PATH' is outside the intake contract's allowed_edit_surface." >&2
  echo "Either this edit is scope drift (re-plan), or the surface was declared" >&2
  echo "too narrowly (amend .feature/intake.json WITH user sign-off, then retry)." >&2
  exit 2
fi

exit 0
