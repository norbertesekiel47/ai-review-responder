# Handoff: #543 Run-engine executor

## Checkpoint

- Phase: `replanning` after mandatory adversarial review
- Branch: `codex/543-run-engine-executor`
- Worktree:
  `/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-543-run-engine-executor`
- Risk/surface: high / backend / DB-touching
- Implementation status:
  T1 `551e171b`, T2 `ff824766`, T3 `dc0f76c9`, T4 `bd1d9e97`,
  parallel-DB isolation `cc6d2c4c`
- Migration status: 088 reserved by this feature; unapplied everywhere
- Blocked migration: issue #546 remains out of flight

The first full DB-backed gate passed at `cc48de5e`, then the mandatory
adversarial review found four valid no-ship gaps: tenant-composite run foreign
keys, the shared offboarding processing gate, terminal batch failure alerts,
and an unbounded visit-by-ask history join. The second surface amendment
triggered the feature workflow abort criterion, so
`codex-543-run-engine-executor-postmortem.md` records the restart and the
intake/plan now lock the four fixes plus exact regression titles.

The high-risk plan reviewer reached its three-round cap with one final
edit-surface omission. That omission was corrected by adding the shared
outbox module and its focused test to the intake; the user explicitly approved
the corrected contract on 2026-07-24.

Post-fix reclassification measured 3,999 changed lines across 39 files. This
exceeds twice the original estimate but remains in the same high-risk backend
feature lane for the reasons recorded in the plan's classification section.

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

1. Confirm both intake copies match and the ARM CHECK is green.
2. Obtain the required high-risk plan approval for the restarted T5 tracer.
3. Delegate the three implementation slices to fresh subagents using TDD.
4. Run the full DB-backed gate and `pnpm build`; integration SKIP is not
   acceptable.
5. Continue the deviations read-back and two-axis review only after the
   remediation gate is fully green.

Do not reconstruct intent from conversation history. Read the intake, plan,
specification, ADR, and named glossary excerpt above.
