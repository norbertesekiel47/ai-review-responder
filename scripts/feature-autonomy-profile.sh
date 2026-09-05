#!/usr/bin/env bash
# scripts/feature-autonomy-profile.sh — /feature speed lane, build 2:
# write the WORKTREE-scoped autonomy profile (.claude/settings.local.json)
# so an armed /feature run executes steps 4–6 without permission prompts.
#
#   bash scripts/feature-autonomy-profile.sh          # write the profile
#   bash scripts/feature-autonomy-profile.sh --remove # delete it
#
# Why this is safe (the sandbox argument, 2026-08 auto-mode consensus):
# the worktree IS the sandbox — the edit-surface guard blocks writes outside
# the intake's allowed_edit_surface, the stop gate blocks "done" without gate
# evidence, and the file is gitignored so the profile never follows a merge.
# The profile auto-accepts EDITS (acceptEdits) and allowlists only the
# workflow's own read/verify commands. It deliberately allowlists NOTHING at
# the shipping boundary: git commit/push, gh, deploys, migrations, and flag
# flips still prompt.
#
# Refusals: never in the parent checkout (main/staging), never without an
# armed intake, never over a hand-written settings.local.json. Opt out
# per-run with FEATURE_AUTONOMY_PROFILE=off.
set -uo pipefail

if [ "${FEATURE_RUNTIME:-${CODEX_THREAD_ID:+codex}}" = codex ]; then
  echo "Codex uses its configured sandbox and approval policy; no Claude permission profile is written."
  exit 0
fi

ROOT=$(git rev-parse --show-toplevel)
cd "$ROOT"
TARGET=".claude/settings.local.json"

if [ "${1:-}" = "--remove" ]; then
  rm -f "$TARGET"
  echo "autonomy profile removed: $TARGET"
  exit 0
fi

if [ "${FEATURE_AUTONOMY_PROFILE:-on}" = "off" ]; then
  echo "autonomy profile: skipped (FEATURE_AUTONOMY_PROFILE=off)"
  exit 0
fi

BRANCH=$(git branch --show-current)
case "$BRANCH" in
  main|staging|"")
    echo "autonomy profile: REFUSED — '$BRANCH' is not a feature worktree. The profile is worktree-only by design."
    exit 1
    ;;
esac

if [ ! -f .feature/intake.json ]; then
  echo "autonomy profile: REFUSED — no .feature/intake.json (worktree not armed). Run scripts/feature-setup.sh first."
  exit 1
fi

# An existing profile with user content must not be clobbered silently.
if [ -f "$TARGET" ] && ! grep -q '"__feature_autonomy_profile"' "$TARGET"; then
  echo "autonomy profile: REFUSED — $TARGET exists and was not written by this script. Merge by hand or remove it first."
  exit 1
fi

mkdir -p .claude
cat > "$TARGET" <<'JSON'
{
  "__feature_autonomy_profile": "written by scripts/feature-autonomy-profile.sh — worktree-scoped, gitignored, safe to delete",
  "permissions": {
    "defaultMode": "acceptEdits",
    "allow": [
      "Bash(pnpm lint:*)",
      "Bash(pnpm typecheck:*)",
      "Bash(pnpm test:*)",
      "Bash(pnpm vitest:*)",
      "Bash(pnpm tsx:*)",
      "Bash(bash scripts/verify-gate.sh:*)",
      "Bash(bash scripts/arm-check.sh:*)",
      "Bash(bash scripts/feature-state.sh:*)",
      "Bash(bash scripts/gate-summary.sh:*)",
      "Bash(bash scripts/blast-radius.sh:*)",
      "Bash(bash .agents/skills/feature/scripts/verified-gate.sh:*)",
      "Bash(node .agents/skills/feature/scripts/:*)",
      "Bash(git status:*)",
      "Bash(git diff:*)",
      "Bash(git log:*)",
      "Bash(git show:*)",
      "Bash(git rev-parse:*)",
      "Bash(git merge-base:*)",
      "Bash(rg:*)",
      "Bash(jq:*)"
    ]
  }
}
JSON

jq -e . "$TARGET" >/dev/null || { echo "autonomy profile: wrote invalid JSON — aborting"; rm -f "$TARGET"; exit 1; }
echo "autonomy profile: $TARGET written (acceptEdits + workflow command allowlist; shipping boundary still prompts)"
