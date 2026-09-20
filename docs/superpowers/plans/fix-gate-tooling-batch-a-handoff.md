# Handoff — fix/gate-tooling-batch-a

Batch A, gate tooling. Three implementation tickets plus one verify-and-close.

## Where the run is

**Step 7 complete. Review round 1 closed, gate GREEN, ready for the draft PR.**

Batch A grew from four tickets to five. #1305 needed no code — verified against
`c9b2a2f9a`, 92/92 under three-agent load. The fifth ticket was found BY this
branch's own gate: `mutation-runner.mjs`'s watcher scan was machine-global
while its docstring claimed worktree scope, so an unrelated checkout's dev
server turned a gate row red. Owner-directed, second surface amendment,
reason recorded.

Review round 1: **11 findings, 11 verified, 11 fixed, 0 rejected** — one
BLOCKING (the carry anchor, my design error), three MAJOR. Full record in
`docs/reviews/fix-gate-tooling-batch-a/triage.md`.

Final gate GREEN with one WARN left deliberately standing: the test bucket is
2.9x its estimate (production is 1.8x, under the trigger). Step 0 was re-run
as the trigger requires and CONFIRMED the lane. The estimate was not edited —
see triage.md for why.

### Original plan note

Plan approved. Step 4 (execute tracers) next.

- Worktree: `/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/fix-gate-tooling-batch-a`
- Branch: `fix/gate-tooling-batch-a`, forked from `3795a0f5` (`origin/main`, zero drift at fork).
- Lane: SIZE = standard · RISK = normal · SURFACE = backend.

## Artifacts, by path

| What | Path |
|---|---|
| Locked intake | `docs/superpowers/plans/fix-gate-tooling-batch-a-intake.json` |
| Plan (tracers T1-T4, module design, test titles) | `docs/superpowers/plans/fix-gate-tooling-batch-a-plan.md` |
| Deviations | `docs/superpowers/plans/fix-gate-tooling-batch-a-deviations.md` |
| Review reports (after step 7) | `docs/reviews/fix-gate-tooling-batch-a/` |
| Tickets | GitHub `#1107`, `#1108`, `#1199`, `#1305` |

## Decisions the owner locked at step 1

1. **#1305** — verify the landed fix (`c9b2a2f9a`, PR #1310) and close. No code.
2. **#1107 §2** — pin the working stub-init behavior with a test AND make the
   silent axis default fail loudly. The reported symptom does not reproduce.
3. **#1107 §1** — carry the parent ladder only when its axes match the intake
   AND it is no older than the intake file. The carry prints its own outcome.
4. **#1199** — a derived guard, not a hardcoded list of suites.

## Two findings the tickets do not carry

- **#1199 understates the hole.** `src/__tests__/design-doc-token-pin.test.ts`
  reads three `docs/brand-asset-library/design-systems/*/DESIGN.md` files at run
  time. Three doc-reading suites skip on a docs-only pull request, not two.
- **#1107 §1 reproduced during this run's own arming.** `arm-check.sh` printed
  *"initialized from the intake (no parent ladder carried)"* and the ladder
  below it carried the parent's note. The carry ran and said nothing.

## Traps for whoever picks this up

- Plan test title 4, `keeps the gate honest about a title that carries an
  author's apostrophe`, must be written SINGLE-quoted in the source so the
  apostrophe is escaped. It is the end-to-end proof of #1108 at the gate's own
  promised-tests row. Rewording it removes the proof.
- Every fixture that spawns `git` passes `env: GIT_FREE_ENV`
  (`.claude/rules/ci-tooling.md`).
- `scripts/gate-promised-tests.sh` is SOURCED. It must never `exit` — that
  would leave the previous run's green `gate-status.json` on disk for the stop
  hook to read as this run's result.
- T1 and T3 both edit `scripts/verify-gate.sh`. T1 runs alone first; T2 and T3
  are independent of each other after it.
- `lefthook.yml` may already cover #1199 through its `guards` command. Verify
  before editing; a duplicate command is drift, not coverage.
