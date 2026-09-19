# Handoff — refactor/616-fallow-complexity

A resumed session bootstraps from this file. It never needs the prior
transcript. Everything below is a path, not a restatement.

## What this is

GitHub issue **#616** — two pre-existing fallow complexity findings, cleared by
decomposition rather than suppression. Behavior-preserving.

## Artifacts (read in this order)

| what | path |
|---|---|
| Locked intake | `docs/superpowers/plans/refactor-616-fallow-complexity-intake.json` |
| Plan (5 tracers) | `docs/superpowers/plans/refactor-616-fallow-complexity-plan.md` |
| Deviations | `docs/superpowers/plans/refactor-616-fallow-complexity-deviations.md` |
| Review reports | `docs/reviews/refactor-616-fallow-complexity/` |
| Red-team sidecar | `docs/reviews/red-team/<slug>/findings.{md,json}` |

Glossary: none. This branch coins no domain term — it moves existing code and
adds no concept. `CONTEXT-MAP.md` needs no entry.

## Lane

`size: small` · `risk: high` · `surface: backend` · `db_touching: false`

RISK = high because it touches `worker/`. At SIZE = small that means:
abbreviated intake with sign-off (done), **implementation in the orchestrator
session with no subagent dispatch**, the step 7 review wave including the
red-team pass, and the high-risk ship lane (staging ride, then PR to `main`
with a merge pause).

## Worktree

`/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/refactor-616-fallow-complexity`

Sibling worktree, own `node_modules`, ARMED (edit-surface guard + stop gate).
Base SHA `2870e1097d09b6c05d95092b768e831f50b379c0`.

## Review sessions

| round | axis | runtime | session id |
|---|---|---|---|
| plan round 1 | plan skeptic | `codex exec -m gpt-6-astra` | `01a0ba18-fe60-7bb2-b5fa-211238b37576` |

Resume that id **only** for a verification-only round
(`codex exec resume 01a0ba18-fe60-7bb2-b5fa-211238b37576 "<delta>"`). Never for
an independent axis — a resumed session is anchored on its earlier conclusions.

Note: the round drifted out of read-only late in its run — it chose to invoke
`scripts/verify-gate.sh` after a hook prompt, having itself observed the gate
is not read-only. It wrote only `.feature/` state. Gate truth is always
re-derived here, never reused, so this changes nothing. Its findings are still
judged on their evidence.

## Baseline measurements (base SHA, before any edit)

Three target suites green: **31 tests** — 12 in
`src/lib/shared/__tests__/logger.test.ts`, 4 in
`worker/jobs/__tests__/OnboardingDemoWorker.test.ts`, 15 in
`worker/jobs/onboarding-demo/__tests__/stages.test.ts`.

`fallow health` **inside the worktree** (no `coverage/` present, so fallow
assumes 40% coverage):

| function | cyclomatic | cognitive | lines | exceeded | CRAP |
|---|---|---|---|---|---|
| `src/lib/shared/logger.ts:47` `emit` | 20 | 24 | 53 | `cognitive_crap` | 106.4 (critical) |
| `worker/jobs/OnboardingDemoWorker.ts:35` `handleOnboardingDemo` | 19 | 25 | 144 | `cognitive_crap` | 97 |

**The worktree numbers differ from the main checkout's** (106.4/97 vs
420-scale / 50.7), because the main checkout has a stale
`coverage/coverage-final.json` from 2026-09-11 and the worktree has none.
Consequence: at the 40% default, cyclomatic must reach **9 or below** to hold
CRAP under 30. The proof run must pass real regenerated coverage.

Baseline gate (`--baseline`, mode `docs_only`): RED on exactly two rows, both
expected and both load-bearing evidence that the checks can fail —

- `feature-surface` — `subscription-guard.ts` and `cost-reconcile.ts` do not
  exist yet. T4/T5 resolve it.
- the targeted fallow assertion — fires and names both findings.

## Corrections found before implementation

Both came from reading source, not from a reviewer. Fold into the post-round
fix pass:

1. **T1 test 6 trigger is wrong in the plan.**
   `sanitizeAnalyticsProperties` (`src/lib/analytics/events.ts:111-128`) copies
   only `string | number | boolean | null`, so a `BigInt` in an object arg is
   DROPPED and never reaches the record. `LogContext`
   (`src/lib/shared/log-context.ts:7-17`) is all-optional-string, so it cannot
   carry one either. The only reachable trigger for the record-level
   `JSON.stringify` catch is an `Error` whose `message` (or `name`/`stack`)
   property is non-serializable — e.g.
   `Object.defineProperty(err, 'message', { value: 10n })`.
2. **The package has ONE test file, not one per module.**
   `worker/jobs/onboarding-demo/__tests__/stages.test.ts` (371 lines) holds a
   `describe` block per module. The plan invented
   `subscription-guard.test.ts` and `cost-reconcile.test.ts`. Follow the
   precedent instead. That forces a better interface:
   `guardOnboardingDemoSubscription` must take `failTerminal` as an **injected
   parameter**, because `stages.test.ts` tests the real
   `failOnboardingDemoTerminal` in its own `describe` and therefore cannot
   `vi.mock('../terminal')` file-wide. `@sentry/node` is unused anywhere in the
   package, so mocking it file-wide for the cost-reconcile block is safe.

## Where the run is

Step 3. Plan written, `PREVALIDATE: PASS`, plan round 1 dispatched. Next:
triage the skeptic's findings, apply them together with the two corrections
above, ask `bash scripts/feature-state.sh contract-changed <plan.md>` whether a
verification round is owed, then set `phase=plan_approved` and start T1.

## Resume

`/feature-resume refactor/616-fallow-complexity`
