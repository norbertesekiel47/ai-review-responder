# Handoff — feat/stripe-customer-redaction

Rewritten 2026-09-03 during the execute phase. Resume with
`/feature-resume feat/stripe-customer-redaction`.

The run is **ARMED and live** — the earlier deliberate park is over,
`.feature/intake.json` is back in place, and `arm-check.sh` reports ARMED.

## Artifacts, by path

Read these; this file never restates them.

| What | Path |
|---|---|
| Locked intake (audit copy) | `docs/superpowers/plans/feat-stripe-customer-redaction-intake.json` |
| Arming copy (byte-identical) | `.feature/intake.json` |
| Plan | `docs/superpowers/plans/feat-stripe-customer-redaction-plan.md` |
| Deviations (D1, D2, D3 — all ACCEPT) | `docs/superpowers/plans/feat-stripe-customer-redaction-deviations.md` |
| Machine state | `.feature/state.json` |
| Glossary terms coined | `CONTEXT.md` § "Stripe Customer redaction" |

Worktree root: `/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-stripe-customer-redaction`

## State

- Phase `executing`. Fork point is `origin/main` at `b9fb9601` — the branch was
  **rebased** on resume when it was 3 commits behind, before the review wave
  opened. It is 0 behind now. Do not rebase again once the review wave starts.
- Plan review rounds: **3 of 3, exhausted.** Branch review rounds: 0.
- Surface amendments: **3 of the budget used**, and all three are now actually
  written into the intake. A fourth needs owner sign-off.
- Intake hash `5a5b508c…`, identical across both copies and `state.json`.

## What resume found, and fixed

Recorded because a later session will otherwise re-derive it wrongly.

1. **The run was parked, not broken.** `.feature/intake.json` had been renamed
   to `intake.parked.json` on purpose so the stop gate would not block an
   unrelated session on a gate that was legitimately red before implementation
   existed. Renaming it back re-armed cleanly.
2. **`state.json` carried a stale `headSha`** (`bc2cddf3`, two commits behind).
   Repaired via `feature-state.sh set-phase`.
3. **Surface amendment 3 was logged but never applied.** See deviation D3. It
   named `worker/background/pollers/health-alert/__tests__/checks.test.ts`,
   which no `allowed_edit_surface` entry matched, so promised test title 43 had
   no legal home. Owner-approved on resume; applied in `0c4c5b8f`.

## Tracers

| Tracer | State | Commit |
|---|---|---|
| T0 — all 45 promised tests, red | done | `80894a30` |
| T1 — `redactStripeCustomer` + directory row | done | `d64f6b3a` |
| T2 — purge stage, D5 ordering, D8 lock | done | `50e0d98a` |
| T3 — classification and disclosure | done | `52f1dc14` |
| T4 — webhook retry bound | in flight | — |

T3 and T4 were delegated to subagents with disjoint file leases; T0, T1 and T2
were implemented in the root context. The T1 first-task enforcement spot check
passed: every changed file matched `allowed_edit_surface`, zero violations.

### Two things worth knowing about the promised tests

- **Titles 38 and 43 were GREEN at T0, by design.** Both are pins on premises
  the design rests on, not behaviour this branch adds. 38 pins that
  `buildCheckoutSessionParams` passes `customer_email` and never `customer`,
  which is the entire reason D10's residual is accepted. 43 pins that
  `checkFailedInboundEvents` filters `status='failed'` only. A change that
  breaks either premise now fails loudly.
- **The T0 meta-check (title 37) initially reported its own comment** as a
  pending test. Fixed in `d64f6b3a`; it now skips comment lines. A false
  positive there teaches the next reader to ignore the check.

## Next actions, in order

1. **Wait for T4, then review its diff.** Never start the gate while it is in
   flight — the tree is mid-edit and the result is false in either direction.
2. **Run `bash scripts/verify-gate.sh` once, against the resulting HEAD**, as
   the final serialized step. Record the SHA the evidence was produced at.
   `db_touching` is true, so the gate provisions the test database and runs the
   two edited integration suites; a `SKIP` row on those makes the gate not
   review-ready.
3. Deviations read-back, review wave, red team (RISK is high, so the
   adversarial pass is required and `red-team-status.mjs` fails its absence).
4. Staging, then PR. Pause for explicit merge approval.

## Gate

`.feature/gate-status.json` at the time of writing is **stale** — timestamp
`1788432111`, produced before any implementation existed. Its single failure,
`feature-surface`, was CORRECT then: the intake named
`src/lib/account-offboarding/stripe-customer-redaction.ts` and T1 had not yet
created it. That file exists now. Treat the recorded result as carrying no
information about the current tree.

**Do not put per-path `pnpm test <dir>` in `verification_commands`.** That was
deviation D2: the gate runs its `extra-*` rows in parallel, and concurrent
vitest processes against one Postgres test database interfere. The gate's own
`pnpm test` row already covers every suite with the right serialization.
`verification_commands` is deliberately empty.

## Things earlier sessions got wrong

Kept so they are not repeated.

1. An earlier session told the owner an acked webhook event stayed
   "operator-replayable". It did not. Plan round 2 disproved it and D9 changed
   as a result — the ack writes `stale_ignored`, never `processed`, because
   `claimInboundEvent` returns `duplicate` for `processed`.
2. An earlier session estimated the D8 lock as "two call sites, one file" when
   six transaction-opening callers existed. Placing the lock in
   `applyStripeSubscriptionStateInternal` restored the small footprint, but the
   estimate was wrong when the owner decided on it.
3. This session claimed T4 had finished when it had not — the completion signal
   watched a stale transcript path. Verify an agent's state with `ListAgents`,
   not a file size.

Codex asserted twice that `worker/jobs/account-offboarding` has a pre-existing
test failure. It does not: the suite is green when run with
`TEST_DATABASE_POOL_URL` exported. That red was deviation D2, now removed.
