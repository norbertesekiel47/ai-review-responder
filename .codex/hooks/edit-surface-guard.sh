#!/usr/bin/env bash
# Codex PreToolUse guard for apply_patch during a /feature run.
#
# Codex supplies tool_name + tool_input.command. For apply_patch, the command
# contains the patch envelope, so extract its Add/Update/Delete/Move paths and
# enforce the same intake contract as the Claude guard.
set -uo pipefail

# A linked worktree (`git worktree add`) keeps its OWN per-worktree git dir, so
# --absolute-git-dir and --git-common-dir name different paths there; in the
# primary checkout they name the same one. #1338: this replaces a path-pattern
# test (`*-worktrees/*`, `*/.claude/worktrees/*`, `*/.worktrees/*`) that armed
# only for the three layouts scripts/new-worktree.sh and the harness happen to
# produce. A real linked worktree anywhere else — an Orca workspace at
# ~/orca/workspaces/<repo>/<slug> — matched nothing and ran UNGUARDED, which is
# the one case this rule exists to catch. `--path-format=absolute` needs git
# 2.31; the fallback resolves a relative common dir against the same directory
# git read it from.
is_linked_worktree() {
  local git_dir common_dir
  git_dir=$(git -C "$1" rev-parse --absolute-git-dir 2>/dev/null) || return 1
  common_dir=$(git -C "$1" rev-parse --path-format=absolute --git-common-dir 2>/dev/null) \
    || common_dir=$(git -C "$1" rev-parse --git-common-dir 2>/dev/null) || return 1
  case "$common_dir" in /*) ;; *) common_dir="$1/$common_dir" ;; esac
  [ "$git_dir" != "$common_dir" ]
}

INPUT=$(cat)
HOOK_CWD=$(jq -r '.cwd // empty' <<<"$INPUT" 2>/dev/null || true)
[ -n "$HOOK_CWD" ] || HOOK_CWD="$PWD"
TOOL_NAME=$(jq -r '.tool_name // empty' <<<"$INPUT" 2>/dev/null || true)
COMMAND=$(jq -r '.tool_input.command // empty' <<<"$INPUT" 2>/dev/null || true)
SESSION_ID=$(jq -r '.session_id // empty' <<<"$INPUT" 2>/dev/null || true)

extract_paths() {
  local path
  if [ "$TOOL_NAME" = "apply_patch" ]; then
    printf '%s\n' "$COMMAND" \
      | sed -n -E -e 's/^\*\*\* (Add|Update|Delete) File: ?//p' -e 's/^\*\*\* Move to: ?//p'
  else
    path=$(jq -r '.tool_input.file_path // empty' <<<"$INPUT" 2>/dev/null || true)
    [ -n "$path" ] && printf '%s\n' "$path"
  fi
}

repo_root_for() {
  local path="$1" anchor
  case "$path" in
    /*) anchor=$(dirname "$path") ;;
    *) anchor="$HOOK_CWD" ;;
  esac
  while [ ! -d "$anchor" ] && [ "$anchor" != "/" ]; do
    anchor=$(dirname "$anchor")
  done
  git -C "$anchor" rev-parse --show-toplevel 2>/dev/null || true
}

absolute_path_for() {
  python3 -c 'from pathlib import Path; import sys; print((Path(sys.argv[1]) / sys.argv[2]).resolve())' "$HOOK_CWD" "$1"
}

session_root=$(git -C "$HOOK_CWD" rev-parse --show-toplevel 2>/dev/null || true)

# Loop-invariant: whether containment applies at all. #1338 also gave this copy
# the escape hatch the Claude guard has always documented — without it, the
# message below would name a variable this script ignored.
session_contained=false
if [ "${WORKTREE_EDIT_GUARD_DISABLE:-0}" != "1" ] && [ -n "$session_root" ] \
  && is_linked_worktree "$session_root"; then
  session_contained=true
fi

while IFS= read -r FILE_PATH; do
  [ -n "$FILE_PATH" ] || continue
  ABS_PATH=$(absolute_path_for "$FILE_PATH") || exit 2
  TARGET_ROOT=$(repo_root_for "$ABS_PATH")

  # Preserve the always-on containment rule for worktree sessions.
  if [ "$session_contained" = true ] && [ -n "$TARGET_ROOT" ] \
    && [ "$TARGET_ROOT" != "$session_root" ]; then
    echo "BLOCKED: session cwd is worktree '$session_root' but the edit targets '$TARGET_ROOT'." >&2
    echo "Point the patch path at the worktree root — an edit to another checkout silently" >&2
    echo "lands in that tree. Set WORKTREE_EDIT_GUARD_DISABLE=1 if that is genuinely intended." >&2
    exit 2
  fi

  ROOT=""
  if [ -n "$TARGET_ROOT" ] && [ -f "$TARGET_ROOT/.feature/intake.json" ]; then
    ROOT="$TARGET_ROOT"
  elif [ -n "$session_root" ] && [ -f "$session_root/.feature/intake.json" ]; then
    ROOT="$session_root"
  fi
  [ -n "$ROOT" ] || continue

  if [ -n "$TARGET_ROOT" ] && [ "$TARGET_ROOT" != "$ROOT" ]; then
    echo "BLOCKED: edit targets checkout '$TARGET_ROOT' but the feature is armed in '$ROOT'." >&2
    exit 2
  fi

  [ -z "$TARGET_ROOT" ] && continue

  if [ -n "$SESSION_ID" ]; then
    SESSIONS_FILE="$ROOT/.feature/sessions"
    grep -qxF "$SESSION_ID" "$SESSIONS_FILE" 2>/dev/null \
      || printf '%s\n' "$SESSION_ID" >> "$SESSIONS_FILE"
  fi

  REL_PATH="${ABS_PATH#"$ROOT"/}"
  case "$REL_PATH" in
    .feature/*|docs/*|CONTEXT.md|CONTEXT-MAP.md) continue ;;
  esac

  case "$REL_PATH" in
    package.json|pnpm-lock.yaml|*/package.json)
      if [ ! -f "$ROOT/.feature/deps-justification.md" ]; then
        echo "BLOCKED: dependency manifest edit without .feature/deps-justification.md." >&2
        exit 2
      fi
      ;;
  esac

  MATCHED=false
  while IFS= read -r GLOB; do
    [ -n "$GLOB" ] || continue
    # Escape '[' and ']' so a Next.js dynamic route segment is matched LITERALLY
    # — the SAME escape the Claude guard (.claude/hooks/edit-surface-guard.sh)
    # and scripts/ci/feature-surface-audit.ts apply. Until #867 this port
    # matched the raw glob, so '[id]' was a bash character class here while the
    # other two matchers read it literally: no single spelling satisfied all
    # three, and intakes grew a pre-escaped duplicate ('\[id\]', '[[]id[]]')
    # that matches ONLY here. Brackets are always literal in a surface glob;
    # never pre-escape them in the intake (ci:feature-surface rejects it).
    # Character classes are therefore not expressible; '*' and '?' still work.
    ESCAPED_GLOB="${GLOB//\[/\\[}"
    ESCAPED_GLOB="${ESCAPED_GLOB//\]/\\]}"
    # shellcheck disable=SC2254
    if [[ "$REL_PATH" == $ESCAPED_GLOB ]]; then MATCHED=true; break; fi
  done < <(jq -r '.allowed_edit_surface[]?' "$ROOT/.feature/intake.json")

  if [ "$MATCHED" = false ]; then
    echo "BLOCKED: '$REL_PATH' is outside the intake contract's allowed_edit_surface." >&2
    exit 2
  fi
done < <(extract_paths)

exit 0
