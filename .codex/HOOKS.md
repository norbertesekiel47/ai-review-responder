# RepWorth Codex hooks

The Claude-derived feature guards are ported to Codex-compatible hooks under
`.codex/hooks/` and registered in `.codex/hooks.json`. This file records the
compatibility decisions, validation, and remaining limits.

## edit-surface-guard.sh

The port reads Codex's JSON payload, supports `apply_patch` paths as well as
legacy `tool_input.file_path`, and keeps the `.feature/intake.json` contract,
worktree containment, dependency-justification check, and explicit escape
hatch. It records the current Codex session ID in `.feature/sessions/`.

The original Claude policy was valuable, but its input adapter only understood
Claude tool payloads. The Codex port covers `apply_patch` and Bash tool input.

## migration-immutability-guard.sh

The migration policy is portable. The Codex adapter checks patch paths and
Bash command text, and reads the authoritative
`.claude/reference/migrations-log.md`. A missing or malformed log fails
closed. New migrations remain allowed; applied migrations are blocked.

## stop-gate.sh

The green/stale gate policy is portable and valuable. The hook uses Codex's
stop-hook payload and scans registered worktrees for armed runs. It blocks a
missing, red, or stale `.feature/gate-status.json`; CI remains the stronger
authoritative enforcement layer.

## typecheck-on-stop.sh

The policy is portable: fingerprint dirty TypeScript files, run typecheck and
changed-file ESLint once per state, and feed failures back. Deleted TypeScript
files still trigger the project typecheck but are excluded from ESLint's file
arguments; untracked TypeScript files remain included. The Codex port derives
the repository root from Git and uses the session ID from the stop payload. CI
and pre-push checks remain the stronger enforcement layer.

## Global cbm hooks

The session reminder can become a Codex SessionStart candidate if the codebase-memory MCP server is registered. The discovery gate is not directly portable: it blocks Claude's Grep, Glob, and Read flow, while Codex uses different tools. Preserve the preference in AGENTS guidance and only add a gate after confirming the actual Codex tool names and MCP availability.

## Project UI post-tool hook

The local Claude settings referenced `~/.claude/skills/impeccable/scripts/hook.mjs`.
That dependency was not present as a user-owned source skill and is not safe
to activate in Codex, so the broken project-local PostToolUse registration was
removed. Recreate it only after identifying the exact provider or package and
confirming its Codex hook contract.

## Trust and maintenance

The current hook definition has been reviewed and trusted in Codex. After any
change to `.codex/hooks.json` or `.codex/hooks/*.sh`, review it again through
Codex's `/hooks` UI because hooks are executable policy. Run
`pnpm ci:agent-config` for static validation and keep CI plus pre-push
enforcement in place.
