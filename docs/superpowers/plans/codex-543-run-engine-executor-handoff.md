# Handoff: #543 Run-engine executor

## Checkpoint

- Phase: `plan_approved`
- Branch: `codex/543-run-engine-executor`
- Worktree:
  `/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-543-run-engine-executor`
- Risk/surface: high / backend / DB-touching
- Implementation status: not started
- Migration status: 088 reserved by this feature; unapplied everywhere
- Blocked migration: issue #546 remains out of flight

The high-risk plan reviewer reached its three-round cap with one final
edit-surface omission. That omission was corrected by adding the shared
outbox module and its focused test to the intake; the user explicitly approved
the corrected contract on 2026-07-24.

## Sources of truth

- Intake:
  `docs/superpowers/plans/codex-543-run-engine-executor-intake.json`
- Plan:
  `docs/superpowers/plans/codex-543-run-engine-executor-plan.md`
- Executor specification:
  `docs/superpowers/specs/2026-07-23-run-engine-executor-shape.md`
- Restraint-policy specification:
  `docs/superpowers/specs/2026-07-23-restraint-policy-v-watch.md`
- Architecture decision:
  `docs/adr/0011-watch-mode-executor-shape.md`
- Glossary excerpt:
  `CONTEXT.md` lines 34–40 (`Solicitation batch`, `Ask`,
  `Logical fan-out`, `Batch candidate window`,
  `Simulated contact history`)
- Schema authority:
  `.claude/reference/migrations-log.md`
- Ticket/map:
  GitHub issues #543 and #528
- Carry-forward decisions:
  GitHub comments on #534 and #543 linked from the intake-session record
- Optional nearby cleanup:
  issue #565 is out of scope except a local extraction required by
  `terminalizeUpload`

## Resume

1. Re-run the ARM CHECK and confirm both intake copies match.
2. Set phase `executing`.
3. Execute plan tracers T1 through T4 in blocking-edge order with fresh
   per-task subagents and TDD.
4. After T1, compare every dirty path with `allowed_edit_surface` before
   dispatching T2.

Do not reconstruct intent from conversation history. Read the intake, plan,
specification, ADR, and named glossary excerpt above.
