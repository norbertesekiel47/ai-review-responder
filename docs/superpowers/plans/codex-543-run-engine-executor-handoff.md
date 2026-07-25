# Handoff: #543 Run-engine executor

## Checkpoint

- Phase: step-7 review triaged; final post-review gate next
- Branch: `codex/543-run-engine-executor`
- Worktree:
  `/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-543-run-engine-executor`
- Risk/surface: high / backend / DB-touching
- Implementation status:
  T1 `551e171b`, T2 `ff824766`, T3 `dc0f76c9`, T4 `bd1d9e97`,
  parallel-DB isolation `cc6d2c4c`, adversarial remediation
  `e09f5d08` through `d0bf4671`, DB-lock diagnosis `9fc3c5d7`, final-review
  fixes `644ce265` and `57c262a1`
- Migration status: 088 reserved by this feature; unapplied everywhere
- Blocked migration: issue #546 remains out of flight

The first full DB-backed gate passed at `cc48de5e`, then the mandatory
adversarial review found four valid no-ship gaps: tenant-composite run foreign
keys, the shared offboarding processing gate, terminal batch failure alerts,
and an unbounded visit-by-ask history join. The second surface amendment
triggered the feature workflow abort criterion, so
`codex-543-run-engine-executor-postmortem.md` records the restart and the
intake/plan now lock the four fixes plus exact regression titles.

The post-fix spec/correctness review passed with no findings. The standards
review's three medium findings were triaged ACCEPT / ACCEPT / ADAPT and its
post-fix verdict is PASS. Review artifacts and blast radius live under
`docs/reviews/codex-543-run-engine-executor/`. The final review gate must be
run from the commit containing those reports and the 21 promised tests.

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
2. Commit the triaged review artifacts, amended intake/plan, deviations, and
   this handoff.
3. Run `scripts/verify-gate.sh --review` with the disposable localhost DB;
   integration SKIP is not acceptable.
4. Set feature state to `reviewed` only when that gate is green.
5. Resume the high-risk ship lane in a fresh session: staging migration 088,
   deploy, and smoke first; production migration and issue #546 stay out of
   flight until the approved promotion step.

Do not reconstruct intent from conversation history. Read the intake, plan,
specification, ADR, and named glossary excerpt above.
