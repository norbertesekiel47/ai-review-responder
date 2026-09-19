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

| round | axis | runtime | session | result |
|---|---|---|---|---|
| plan 1 | plan skeptic | `codex exec -m gpt-6-astra` | `01a0ba18-fe60-7bb2-b5fa-211238b37576` | REVISE — 6 findings, all accepted |
| plan 2 | same, **resumed** | `codex exec resume` | same | REVISE — F5/F6 addressed, 4 residuals, all accepted |
| plan 3 | same, **resumed** | `codex exec resume` | same | **APPROVED** — all 6 closed, 0 shell commands |

The plan-review budget is **spent** (3 of 3). After round 3 the rule is: stop
looping and surface any remaining disagreement to the owner.

Resume that id **only** for a verification-only round. Never for an independent
axis — a resumed session is anchored on its earlier conclusions, which destroys
the independence an axis exists to provide. The resume paid off: round 1 needed
13 shell commands to build context, round 2 needed 3.

**Read-only drift, and the fix.** Round 1 drifted: it ran
`scripts/verify-gate.sh` after a hook prompt, having itself written that the
gate is not read-only. It changed no source, only `.feature/` state, which this
workflow always re-derives. Rounds 2 and 3 were given an explicit instruction
naming that drift, and round 2 complied — it declined a hook's gate request
with "the orchestrator owns gate evidence". **Reuse that instruction verbatim
for the step 7 Codex axis** (deviations D5).

## Baseline measurements (base SHA, before any edit)

Three target suites green: **31 tests** — 11 in
`src/lib/shared/__tests__/logger.test.ts`, 4 in
`worker/jobs/__tests__/OnboardingDemoWorker.test.ts`, 16 in
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

## RESUMED and SHIPPING — read this first (2026-09-19, second session)

The run was parked at step 7.5 and is now un-parked. The owner chose **"Ship
with a recorded exception"** over fixing the red-team tooling first and over
parking again. Step 7.5 is CLOSED by waiver, not by a clean checker pass.

**The #616 work itself is complete and defensible.** Nothing below is a defect
in the refactor.

### What the resumed session changed

- Recorded the owner authorization `issue-616-round-3-residual` in the sidecar
  and set RT-010 / RT-011 to `accepted-risk`. Commit `a16e176`.
- Recorded deviation **D11** — the `reviewed` transition is waived, with the
  reasoning, the risk bound and two tooling follow-ups.
- Merged `origin/main` (commit `700ff9e5`). The one conflict was the
  `arch-review-log.md` row; resolved by keeping all rows, main's two first.
- Re-ran the full gate at the merged HEAD.

### Two corrections to the parked text below

1. **The red gate row does NOT block this branch.** The parked text says the
   mutation-runner failure "will block any branch". It blocks the LOCAL gate
   only. The same file passes in CI — 245 tests green in run `35461113472` — and
   issue **#1334** already owns it, with the correct premise in its title. The
   red row was reproduced on the `main` checkout at `f2de6fb0c` before this was
   concluded.
2. **The accepted-risk step is necessary but NOT sufficient.** It clears one of
   three `red-team-status.mjs` errors. Two survive it and are on record
   unresolved: the stale `head_sha`, and `INCOMPLETE_ORACLE` from inventory row
   `rt-078` (a type-only annotation no vitest case can measure). Both need a
   round 4, which the runner refuses. D11 owns the full reasoning.

### Gate evidence

Full gate at `700ff9e5` (merged HEAD): **33 of 34 rows PASS**. Tests:
1 failed, 15,162 passed, 1,339 skipped. The single failure is the #1334 row.

### The two blockers as the first session recorded them

**1. Gate is RED on a pre-existing failure unrelated to this branch.**
33 of 34 rows PASS. The one failure is
`scripts/ci/__tests__/red-team-mutation-runner.test.ts` →
"runs an admitted baseline mutant and restoration with corroborated report
evidence". Established by experiment, not assumption:

- that file is **not in this branch's diff**;
- it fails identically on the **main checkout**;
- it is **not** caused by the leftover red-team journal — A/B tested with the
  journal moved aside and restored, identical result both ways;
- it PASSED in three earlier full-gate runs on this branch and FAILED in the
  last three, so something environmental flipped.

It deserves its own issue. It will block any branch, not just this one. Do not
edit it to make this branch green.

**2. `red-team-status.mjs` reads OPEN_P0.** RT-010 and RT-011 are FIXED and
hand-verified — each mutant was run and observed to fail a named test — but the
proof is not journaled, because fixing RT-010 moved HEAD and the round budget
(3, owner-authorized) is spent. Recommended close-out: `accepted-risk` on both,
worded as *missing journaled proof, not an unfixed defect*, which a reviewer can
check against the diff.

### A path already tried and REVERTED — do not repeat it

Raising the red-team round cap 3 → 4 was attempted and backed out. The minimal
generalisation (round N>2 opens on an authorization naming that round) breaks
**twelve** deliberate tampering checks, because `RUN_C_FOURTH_TEXT` contains the
literal phrase "approve the scoped fourth round" — so a prose match on
"fourth round" matches a *tampered* Run C admission that the `round > 3` cap
previously refused outright. That same authorization text ends with "keeps
further rounds blocked".

The tooling is byte-identical to `main`; the surface amendment for it was rolled
back. If the cap is ever raised, it must be its own PR, designed around the
Run C interaction rather than discovering it via a broken test.

### Five false claims this run made, all caught by review

Recorded because the pattern matters more than the instances, and D10 owns it:
the "sixth `ClaimResult` member is a compile error" claim; "the root shrank to
~50 lines" (it is 112); "this is the last of the three" `outboxAttempt` sites
(there were four); and two stale gate-fingerprint citations, the second written
while fixing the first. Root cause in every case: asserting completeness without
enumerating the class.

## Where the run is

**Step 8 — shipping.** Steps 1–7 are closed. Step 7.5 is closed by the owner
waiver recorded in D11, not by a clean `red-team-status.mjs` pass; that checker
still reports two errors and the `reviewed` transition is deliberately skipped.

Order taken, high-risk lane: merge `main` → full gate at the merged HEAD →
staging ride (the branch touches `worker/`) → PR to `main` → **pause before
merge**. The merge itself is not authorized.

Historical, for anyone reading the sequence: step 3 closed with the plan
APPROVED at revision 3 (`PREVALIDATE: PASS`, 11 citations resolved, 28 test
titles). Both sessions ran on `opus`, so no model handoff was owed, and RISK =
high at SIZE = small meant every tracer was built in the orchestrator session
with no subagent dispatch.

## Verified mechanics (checked before implementation, so tests do not guess)

- An `Error` whose `message` is a BigInt makes `JSON.stringify` throw
  `TypeError: Do not know how to serialize a BigInt`. T1 test 6's trigger.
- `delete err.stack` leaves `stack === undefined`, so `serializeError`'s
  `&& err.stack` guard omits `error_stack`. T1 test 10's trigger. Both objects
  remain `instanceof Error`.
- The exact byte string `emit` writes with frozen time
  (`2026-01-02T03:04:05.678Z`), `NODE_ENV=production` (stack suppressed) and no
  `LOG_SERVICE`, for
  `createWorkerLogger('[W]', 'corr-1').error('boom happened', new Error('kaput'), { foo: 'bar' })`:

  ```
  {"timestamp":"2026-01-02T03:04:05.678Z","level":"error","service":"worker","logger":"W","message":"boom happened","correlation_id":"corr-1","error_name":"Error","error_message":"kaput","data":{"foo":"bar"}}
  ```

  `console.log` and `console.warn` stayed empty in that probe, so T1 test 8's
  sink-exclusivity assertions hold.
- vitest is 4.1.7; `vi.setSystemTime` has repo precedent
  (`src/lib/onboarding/__tests__/create-business.test.ts:50`).
- `buildOnboardingDemoSource` returns
  `{ result: { reviews, responses, metadata: { totalCostUsd } }, source }`
  (`worker/jobs/onboarding-demo/demo-source.ts:9-16`). With
  `totalCostUsd: 0.0342`, `Math.round(0.0342 * 100) === 3` — T3 test 1's
  fractional-cents fixture.

## Resume

`/feature-resume refactor/616-fallow-complexity`
