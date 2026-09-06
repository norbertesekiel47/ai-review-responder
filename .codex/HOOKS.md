# RepWorth Codex hooks

The Claude-derived feature guards are ported to Codex-compatible hooks under
`.codex/hooks/` and registered in `.codex/hooks.json`. This file records the
compatibility decisions, validation, and remaining limits.

## edit-surface-guard.sh

The port reads Codex's JSON payload, supports `apply_patch` paths as well as
legacy `tool_input.file_path`, and keeps the `.feature/intake.json` contract,
worktree containment, dependency-justification check, and explicit escape
hatch. It records the current Codex session ID in `.feature/sessions`.
Patch rename destinations use the actual `*** Move to:` envelope. Paths are
canonicalized with Python 3 before checking the intake, including `..` and
symlinks, so a spelling change cannot turn a source edit into an allowed docs edit.

The original Claude policy was valuable, but its input adapter only understood
Claude tool payloads. The Codex port covers `apply_patch` and Bash tool input.

Glob semantics are identical to the Claude guard and to
`scripts/ci/feature-surface-audit.ts`: `*` crosses `/`, `?` is one character,
and `[` `]` are escaped at match time so a Next.js dynamic segment is literal.
Until #867 the port matched the raw glob, so `[id]` was a bash character class
here while the other two matchers read it literally — no single spelling
satisfied all three, and intakes grew a pre-escaped duplicate (`\[id\]`,
`[[]id[]]`) that matched only here. Write the plain path; a pre-escaped entry
now matches nothing anywhere and `ci:feature-surface` rejects it.
`scripts/ci/__tests__/edit-surface-guard.test.ts` runs one table against both
guards.

## migration-immutability-guard.sh

The migration policy is portable. The Codex adapter checks patch paths and
Bash command text, and reads the authoritative
`.claude/reference/migrations-log.md`. A missing or malformed log fails
closed. New migrations remain allowed; applied migrations are blocked.
Both sides of a patch rename are checked against the destination repository's
log after canonicalizing the path.

## stop-gate.sh

The green/stale gate policy is portable and valuable. The hook uses Codex's
stop-hook payload and scans registered worktrees for armed runs. It blocks a
missing or red `.feature/gate-status.json`, and requires a matching gate
fingerprint from `gate-fingerprint.mjs check`. Changing uncommitted content
invalidates evidence even when HEAD and the commit timestamp stay unchanged.
Record evidence with `bash .agents/skills/feature/scripts/verified-gate.sh --review`.
CI remains the stronger authoritative enforcement layer.

## typecheck-on-stop.sh

The policy is portable: fingerprint dirty TypeScript files, run typecheck and
changed-file ESLint once per state, and feed failures back. Deleted TypeScript
files still trigger the project typecheck but are excluded from ESLint's file
arguments; untracked TypeScript files remain included. The Codex port derives
the repository root from Git and uses the session ID from the stop payload. CI
and pre-push checks remain the stronger enforcement layer.
The cache hashes tracked diffs and untracked TypeScript contents. Its key binds
the canonical repository root and session, preventing reuse across worktrees.
Lint paths are refreshed after typecheck and missing paths are tolerated if a
concurrent task deletes them. If content changes during verification, the hook
does not cache a green result; the next stable state must be checked again.

## Rule discovery

Path-scoped rules live in `.claude/rules/*.md`; each file's `paths:`
frontmatter names the globs it governs. Claude Code loads a rule on its own
when it reads a matching file. Codex does not — nested instruction files load
only along the root→cwd path, and a root launch loads none — so rule discovery
is instruction-driven, not hook-enforced: before editing, run
`pnpm agent:rules <every path you will edit>` (`scripts/agent-rules.ts`) and
read every file it lists (`none` means no rule applies). No hook checks that
you did; `pnpm ci:agent-config` validates the rules directory itself (frontmatter,
live globs, the 800-word cap, and the AGENTS.md wiring). Layout and caps:
`docs/agents/context-layout.md`.

## Code discovery

Codebase discovery uses local repository tools (`rg`, direct source reads,
tests, and Git history). No codebase-search MCP or discovery-enforcement hook is
required; checked-in source remains the authority.

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
`pnpm ci:agent-config` for static validation and the hook/workflow regressions
under `scripts/ci/__tests__/` after changes. Python 3, Node, jq, Git, and pnpm
are required by the guards and setup. Keep CI plus pre-push enforcement in place.
