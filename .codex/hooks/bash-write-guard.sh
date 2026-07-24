#!/usr/bin/env bash
# Codex PreToolUse guard for Bash write side channels during /feature runs.
set -uo pipefail

INPUT=$(cat)
COMMAND=$(jq -r '.tool_input.command // empty' <<<"$INPUT" 2>/dev/null || true)
[ -n "$COMMAND" ] || exit 0
HOOK_CWD=$(jq -r '.cwd // empty' <<<"$INPUT" 2>/dev/null || true)
[ -n "$HOOK_CWD" ] || HOOK_CWD="$PWD"
SESSION_ID=$(jq -r '.session_id // empty' <<<"$INPUT" 2>/dev/null || true)

list_candidates() {
  printf '%s\n' "$HOOK_CWD"
  local base record
  for base in "$HOOK_CWD"; do
    while IFS= read -r record; do
      case "$record" in
        "worktree "*) printf '%s\n' "${record#worktree }" ;;
      esac
    done < <(git -C "$base" worktree list --porcelain 2>/dev/null)
  done
}

ARMED_LIST=""
while IFS= read -r ROOT; do
  [ -n "$ROOT" ] || continue
  [ -f "$ROOT/.feature/intake.json" ] || continue
  if [ "$ROOT" != "$HOOK_CWD" ]; then
    [ -n "$SESSION_ID" ] || continue
    grep -qxF "$SESSION_ID" "$ROOT/.feature/sessions" 2>/dev/null || continue
  fi
  ARMED_LIST="${ARMED_LIST}${ROOT}"$'\n'
done < <(list_candidates | sort -u)
[ -n "$ARMED_LIST" ] || exit 0

is_source_target() {
  local target="$1" root
  target="${target%\"}"; target="${target#\"}"
  target="${target%\'}"; target="${target#\'}"
  case "$target" in ''| -*) return 1 ;; esac
  while IFS= read -r root; do
    [ -n "$root" ] || continue
    case "$target" in "$root"/*) return 0 ;; esac
  done <<<"$ARMED_LIST"
  case "$target" in
    .feature/*|docs/*|CONTEXT.md|*/.feature/*|*/docs/*|*/CONTEXT.md) return 1 ;;
    /dev/*|/tmp/*|/private/tmp/*|/var/folders/*) return 1 ;;
  esac
  case "$target" in
    src/*|worker/*|scripts/*|supabase/*|public/*|.claude/*|.codex/*|.github/*|./src/*|./worker/*|./scripts/*)
      return 0 ;;
    package.json|pnpm-lock.yaml|lefthook.yml|*.config.ts|*.config.js|tsconfig*.json)
      return 0 ;;
  esac
  return 1
}

block() {
  echo "BLOCKED: Bash write to repository source during a /feature run — $1." >&2
  echo "Use apply_patch for repository edits; scratch belongs in .feature/, docs/, or /tmp." >&2
  exit 2
}

if printf '%s' "$COMMAND" | grep -qE '(^|[;&| ])sed[[:space:]][^;&|]*-i'; then
  while IFS= read -r token; do
    is_source_target "$token" && block "sed -i against '$token'"
  done < <(printf '%s\n' "$COMMAND" | tr -s ' \t' '\n')
fi

EXPECT_REDIRECT=0
TEE_MODE=0
WRITE_CMD=""
CMD_HEAD=1
while IFS= read -r token; do
  [ -n "$token" ] || continue
  if [ "$EXPECT_REDIRECT" = 1 ]; then
    EXPECT_REDIRECT=0
    is_source_target "$token" && block "redirect into '$token'"
    continue
  fi
  case "$token" in
    "&&"|"||"|";"|"|") CMD_HEAD=1; TEE_MODE=0; WRITE_CMD=""; continue ;;
    ">"|">>"|"1>"|"2>"|"&>") EXPECT_REDIRECT=1; continue ;;
    "2>&1"|">&2"|">&1") continue ;;
    ">>"*) is_source_target "${token#>>}" && block "redirect into '${token#>>}'"; continue ;;
    ">"*) is_source_target "${token#>}" && block "redirect into '${token#>}'"; continue ;;
  esac
  if [ "$TEE_MODE" = 1 ]; then
    case "$token" in -*) continue ;; esac
    is_source_target "$token" && block "tee into '$token'"
    continue
  fi
  if [ -n "$WRITE_CMD" ]; then
    case "$token" in -*) continue ;; esac
    is_source_target "$token" && block "$WRITE_CMD against '$token'"
    continue
  fi
  if [ "$CMD_HEAD" = 1 ]; then
    CMD_HEAD=0
    case "$token" in
      tee) TEE_MODE=1 ;;
      mv|cp) WRITE_CMD="$token" ;;
      sudo|env|command|nohup|time) CMD_HEAD=1 ;;
    esac
  fi
done < <(printf '%s\n' "$COMMAND" | tr -s ' \t' '\n')

exit 0
