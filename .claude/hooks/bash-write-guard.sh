#!/usr/bin/env bash
# .claude/hooks/bash-write-guard.sh
#
# PreToolUse guard for the BASH tool during a /feature run. The edit-surface
# guard sees only Edit/Write tool calls; this hook closes the common Bash
# side-channels (sed -i, > redirects, tee, mv/cp) for sessions engaged with
# an armed worktree — the same arming + session-binding rules as the stop
# gate, so unrelated sessions are never touched.
#
# Shell parsing is undecidable, so this is a CONSERVATIVE pattern guard: it
# blocks high-confidence write shapes whose TARGET is repo source, and
# allows on ambiguity (feature.md's NO BASH WRITES rule covers the exotic
# residue — bash -c strings, scripts that write internally, etc.). Exempt
# targets mirror the edit-surface guard: .feature/, docs/, CONTEXT.md, plus
# /tmp and /dev.
set -uo pipefail

INPUT=$(cat)
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty')
[ -n "$COMMAND" ] || exit 0
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // empty')

# --- Arming: any registered armed worktree this session is engaged with ---
list_candidates() {
  printf '%s\n' "$PWD"
  [ -n "${CLAUDE_PROJECT_DIR:-}" ] && printf '%s\n' "$CLAUDE_PROJECT_DIR"
  local BASE
  for BASE in "$PWD" "${CLAUDE_PROJECT_DIR:-}"; do
    [ -n "$BASE" ] || continue
    git -C "$BASE" worktree list --porcelain 2>/dev/null | sed -n 's/^worktree //p'
  done
}

ARMED_LIST=""
while IFS= read -r ROOT; do
  [ -n "$ROOT" ] || continue
  [ -f "$ROOT/.feature/intake.json" ] || continue
  if [ "$ROOT" != "$PWD" ] && [ "$ROOT" != "${CLAUDE_PROJECT_DIR:-}" ]; then
    [ -n "$SESSION_ID" ] || continue
    grep -qxF "$SESSION_ID" "$ROOT/.feature/sessions" 2>/dev/null || continue
  fi
  ARMED_LIST="${ARMED_LIST}${ROOT}
"
done < <(list_candidates | sort -u)

# Not in feature mode for this session -> allow everything.
[ -n "$ARMED_LIST" ] || exit 0

# Does a candidate target token point at repo SOURCE (not exempt scratch)?
# Ordering matters: exempt SURFACES first (.feature/docs — allowed even
# inside an armed root), then armed-root membership (blocks even when the
# root lives under /tmp), then generic scratch locations, then relative
# source-dir shapes.
is_source_target() {
  local T="$1"
  T="${T%\"}"; T="${T#\"}"; T="${T%\'}"; T="${T#\'}"
  case "$T" in
    ''|-*) return 1 ;;
  esac
  # Exempt surfaces (mirror the edit-surface guard's always-allow).
  case "$T" in
    .feature/*|docs/*|CONTEXT.md|*/.feature/*|*/docs/*|*/CONTEXT.md) return 1 ;;
  esac
  # Absolute path inside an armed root?
  local R
  while IFS= read -r R; do
    [ -n "$R" ] || continue
    case "$T" in "$R"/*) return 0 ;; esac
  done <<< "$ARMED_LIST"
  # Generic scratch locations.
  case "$T" in
    /dev/*|/tmp/*|/private/tmp/*|/var/folders/*) return 1 ;;
  esac
  # Relative path that looks like repo source.
  case "$T" in
    src/*|worker/*|scripts/*|supabase/*|public/*|.claude/*|.github/*|./src/*|./worker/*|./scripts/*) return 0 ;;
    package.json|pnpm-lock.yaml|lefthook.yml|*.config.ts|*.config.js|tsconfig*.json) return 0 ;;
  esac
  return 1
}

block() {
  echo "BLOCKED: Bash write to repo source during a /feature run — $1." >&2
  echo "Repo file changes go through Edit/Write (the edit-surface guard must see" >&2
  echo "them). Scratch goes to the scratchpad, /tmp, .feature/, or docs/." >&2
  exit 2
}

# --- sed -i: block if ANY argument token is repo source ---
if printf '%s' "$COMMAND" | grep -qE '(^|[;&| ])sed[[:space:]][^;&|]*-i'; then
  while IFS= read -r TOK; do
    is_source_target "$TOK" && block "sed -i against '$TOK'"
  done < <(printf '%s\n' "$COMMAND" | tr -s ' \t' '\n')
fi

# --- token scan: redirect targets, tee args, mv/cp args ---
EXPECT_REDIRECT=0
TEE_MODE=0
WRITE_CMD=""
CMD_HEAD=1
while IFS= read -r TOK; do
  [ -n "$TOK" ] || continue

  if [ "$EXPECT_REDIRECT" = 1 ]; then
    EXPECT_REDIRECT=0
    is_source_target "$TOK" && block "redirect into '$TOK'"
    continue
  fi

  case "$TOK" in
    "&&"|"||"|";"|"|") CMD_HEAD=1; TEE_MODE=0; WRITE_CMD=""; continue ;;
  esac

  case "$TOK" in
    ">"|">>"|"1>"|"2>"|"&>") EXPECT_REDIRECT=1; continue ;;
    "2>&1"|">&2"|">&1") continue ;;
    ">>"*) T="${TOK#>>}"; is_source_target "$T" && block "redirect into '$T'"; continue ;;
    ">"*)  T="${TOK#>}";  is_source_target "$T" && block "redirect into '$T'"; continue ;;
  esac

  if [ "$TEE_MODE" = 1 ]; then
    case "$TOK" in -*) continue ;; esac
    is_source_target "$TOK" && block "tee into '$TOK'"
    continue
  fi

  if [ -n "$WRITE_CMD" ]; then
    case "$TOK" in -*) continue ;; esac
    is_source_target "$TOK" && block "$WRITE_CMD against '$TOK'"
    continue
  fi

  if [ "$CMD_HEAD" = 1 ]; then
    CMD_HEAD=0
    case "$TOK" in
      tee) TEE_MODE=1 ;;
      mv|cp) WRITE_CMD="$TOK" ;;
      sudo|env|command|nohup|time) CMD_HEAD=1 ;;
    esac
    continue
  fi
done < <(printf '%s\n' "$COMMAND" | tr -s ' \t' '\n')

exit 0
