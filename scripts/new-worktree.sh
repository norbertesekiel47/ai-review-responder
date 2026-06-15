#!/usr/bin/env bash
#
# new-worktree.sh — create an isolated, NON-nested git worktree for one feature.
#
# Usage:
#   pnpm worktree:new <branch> [base-ref]
#   bash scripts/new-worktree.sh <branch> [base-ref]
#
# Why sibling, not nested (the whole point of this script):
#   Worktrees placed *inside* the repo (.claude/worktrees/, .worktrees/) get
#   poisoned by the parent: Node walks UP the tree for node_modules and ESLint
#   walks UP for config, so a nested worktree resolves the parent's deps/config
#   and your local lint/test/typecheck lie about what CI will do. We create the
#   worktree OUTSIDE the repo at  ../<repo>-worktrees/<branch>/  so it owns its
#   own node_modules + config and the local signal is trustworthy.
#
# What it does:
#   1. git worktree add at the sibling path (new branch off origin/main, or
#      checkout of an existing local/remote branch).
#   2. copies the gitignored .env*.local files (not tracked, so they don't ride
#      along with the checkout) — perms preserved (.env.staging.local is 0600).
#   3. pnpm install in the worktree (skip with SKIP_INSTALL=1).
#
# This is for the "several branches in progress, run one stack at a time" flow.
# Running two full stacks at once needs port + queue isolation — out of scope.
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_NAME="$(basename "$REPO_ROOT")"
WT_ROOT="$(cd "$REPO_ROOT/.." && pwd)/${REPO_NAME}-worktrees"

c_reset=$'\033[0m'; c_info=$'\033[1;34m'; c_ok=$'\033[32m'; c_err=$'\033[1;31m'
info() { printf '%s[worktree]%s %s\n' "$c_info" "$c_reset" "$*"; }
ok()   { printf '%s[worktree]%s %s\n' "$c_ok"   "$c_reset" "$*"; }
die()  { printf '%s[worktree] ERROR:%s %s\n' "$c_err" "$c_reset" "$*" >&2; exit 1; }

# --- args + preflight --------------------------------------------------------
BRANCH="${1:-}"
BASE_REF="${2:-}"
[[ -n "$BRANCH" ]] || die "usage: pnpm worktree:new <branch> [base-ref]"
command -v pnpm >/dev/null || die "pnpm not found."

SLUG="${BRANCH//\//-}"                 # feat/foo -> feat-foo for the directory
WT_PATH="$WT_ROOT/$SLUG"
[[ -e "$WT_PATH" ]] && die "Path already exists: $WT_PATH (remove it or pick another branch)."

# --- resolve the base ref for NEW branches -----------------------------------
if [[ -z "$BASE_REF" ]]; then
  git -C "$REPO_ROOT" fetch origin --quiet 2>/dev/null || info "fetch skipped (offline?) — basing off whatever is local."
  if git -C "$REPO_ROOT" show-ref --verify --quiet refs/remotes/origin/main; then
    BASE_REF="origin/main"
  else
    BASE_REF="main"
  fi
fi

# --- create the worktree -----------------------------------------------------
if git -C "$REPO_ROOT" show-ref --verify --quiet "refs/heads/$BRANCH"; then
  info "Checking out existing local branch '$BRANCH' -> $WT_PATH"
  git -C "$REPO_ROOT" worktree add "$WT_PATH" "$BRANCH"
elif git -C "$REPO_ROOT" show-ref --verify --quiet "refs/remotes/origin/$BRANCH"; then
  info "Tracking existing remote branch 'origin/$BRANCH' -> $WT_PATH"
  git -C "$REPO_ROOT" worktree add --track -b "$BRANCH" "$WT_PATH" "origin/$BRANCH"
else
  info "Creating new branch '$BRANCH' off '$BASE_REF' -> $WT_PATH"
  git -C "$REPO_ROOT" worktree add -b "$BRANCH" "$WT_PATH" "$BASE_REF"
fi

# --- carry over gitignored local env (matches .gitignore's .env*.local) ------
copied=0
for f in "$REPO_ROOT"/.env*.local; do
  [[ -e "$f" ]] || continue          # no nullglob: skip the literal pattern
  cp -p "$f" "$WT_PATH/"
  info "copied $(basename "$f")"
  copied=$((copied + 1))
done
[[ "$copied" -eq 0 ]] && info "no .env*.local files found to copy — set env another way if the stack needs it."

# --- install deps (own node_modules = trustworthy local CI) ------------------
if [[ "${SKIP_INSTALL:-0}" == "1" ]]; then
  info "SKIP_INSTALL=1 — skipping pnpm install (run it before lint/test)."
else
  info "Installing deps in the worktree (pnpm hard-links from the global store — cheap)..."
  ( cd "$WT_PATH" && pnpm install )
fi

ok "Ready. Next:"
printf '    cd %s\n' "$WT_PATH"
printf '  When done:\n'
printf '    git -C %s worktree remove %s\n' "$REPO_ROOT" "$WT_PATH"
