# Working rules

The rules both lane routers obey. `.claude/commands/feature.md` (Claude lane)
and `SKILL.md` (Codex lane) differ in who ships and which tools they call —
never in these. This file is their single owner, so a rule cannot drift into
two versions that disagree.

## Context discipline

- **Disk is the source of truth; conversation is disposable.** A locked
  decision lands in a file the moment it is locked — spec, plan, tickets,
  `CONTEXT.md`, ADR. Never carry state forward in chat history.
- **Never pull raw logs into context.** Command output goes to a file. Read
  back a pass/fail summary and the relevant tail.
- **Subagents return summaries, not transcripts.** Full reports go to disk;
  the root reads findings tables.
- **Write a handoff when work actually pauses** — a phase boundary you are
  leaving, another task, or an authority boundary. Not merely because context
  is growing.

## Anti-slop

- **Precedent over invention.** Follow the nearest existing module, test and
  API pattern before creating anything. Name the precedent in the summary.
- **No abstraction before the second use.** Keep the first version concrete
  unless a declared invariant or seam demands otherwise.
- **No new dependency without justification.** A manifest edit requires
  `.feature/deps-justification.md` (reason, alternatives, blast radius). A
  pre-edit hook blocks it otherwise, and `allowed_edit_surface` must cover
  both `package.json` and `pnpm-lock.yaml`.
- **No new file without justification.** Name the existing file considered
  and why it does not fit. `.claude/CLAUDE.md`'s "default is no new file"
  applies doubly here.
- **No new env var or feature flag without a registry entry** in
  `.claude/reference/env-vars.md`, in the same change.
- **Small-diff bias.** A task whose diff sprawls beyond its ticket stops and
  re-plans. It does not push through.
- **Net-negative bias.** A task adding more than ~150 lines while deleting
  none states why. "New code only" is a claim to justify, not a default.
- **Assert impossible states.** Defensive handling of a state the invariants
  exclude hides real bugs. Throw with context instead.
- **No backwards-compatibility shim without a named external consumer.** This
  is a pre-launch codebase — delete the old path and update the callers.
- **Look up, do not guess.** Version-specific API usage goes through Context7
  or the version-matched bundled docs. Repository, issue and CI state goes
  through `gh`. Memory is not a source for anything that can drift.
- **No success claim without evidence.** Green gate output whose fingerprint
  matches this worktree, or it did not happen. The Stop hook enforces it.

## Authority

- Never widen scope silently. Amend the intake with the owner's approval, or
  stop. Count every surface amendment mechanically
  (`bash scripts/feature-state.sh incr-amendment`).
- Never let a reviewer edit. The root verifies each finding before fixing or
  rejecting it. The red-team pass is the one narrow exception: its mutations
  are journaled, finalizer-guarded, and can never reach a commit.
- Never claim a phase from memory. `.feature/state.json` owns the phase,
  `gate-status.json` and the fingerprint own gate truth, `progress.json` owns
  the step ladder.

## Worktree path discipline

Some harnesses reset the shell cwd between calls. Prefix EVERY shell command
with `cd <worktree-root> && …` and use absolute worktree paths for every edit.
Inspect the parent checkout with `git -C <path>`, never a persistent `cd`.

**No bash writes to repo files.** Changes go through the editor tools — never
`sed -i`, shell redirects, `tee`, `mv`/`cp`, or heredocs over repo files,
which route around the edit-surface guard. The common shapes are hook-enforced
(`.claude/hooks/bash-write-guard.sh`); this rule covers the residue its
conservative parser allows. Scratch goes to the scratchpad, `.feature/`, or
`docs/`.
