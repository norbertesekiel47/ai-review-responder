# Handoff — feat/stripe-customer-redaction

Written at the step 3 → 4 boundary, 2026-09-03. Resume with
`/feature-resume feat/stripe-customer-redaction`.

## Artifacts, by path

Read these; this file never restates them.

| What | Path |
|---|---|
| Locked intake (audit copy) | `docs/superpowers/plans/feat-stripe-customer-redaction-intake.json` |
| Arming copy (byte-identical) | `.feature/intake.json` |
| Plan | `docs/superpowers/plans/feat-stripe-customer-redaction-plan.md` |
| Deviations (D1, D2 — both ACCEPT) | `docs/superpowers/plans/feat-stripe-customer-redaction-deviations.md` |
| Machine state | `.feature/state.json` |

Worktree root: `/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-stripe-customer-redaction`

## State

- Phase `plan_approved`. HEAD `bc2cddf3`. Branch ahead of `origin/main` by 6
  commits, all documentation.
- Plan review rounds: **3 of 3, exhausted.** Nothing is left to escalate —
  round 3 verified every mechanism sound and its residue was stale text,
  corrected in `bc2cddf3`.
- Surface amendments: **3 of the budget used.** A fourth needs owner sign-off.
- Codex session for all three rounds: `01a066d6-7a49-7001-b248-83f0ab4d80d4`.
  Round transcripts are in the session scratchpad, not the repo.

## The ten locked decisions

D1–D10 are in the plan's "Locked decisions" table with their evidence. Do not
re-litigate them. The four that cost the most to establish:

- **D5** — the redaction stage runs late, immediately before the tombstone, not
  first. Running first would leave a live account with a wiped Stripe billing
  contact if a later stage failed.
- **D8** — a customer-keyed advisory lock in
  `applyStripeSubscriptionStateInternal`, NOT in the `UnderEntitlementLock`
  wrapper. Both exported entry points funnel through the internal function.
- **D9** — the stale ack writes `stale_ignored`, never `processed`. This is the
  single most important detail on the branch: `claimInboundEvent`
  (`worker/ingress/shared.ts:42`) reclaims only `failed` or a stale `received`
  and returns `duplicate` for `processed`, so acking with `processed` would
  make operator replay strictly worse than today's behaviour.
- **D10** — the D8 ordering residual is accepted, not closed with a marker
  table, because `create-checkout-session.ts:206` passes `customer_email` and
  never `customer`. A test pins that premise.

## Next actions, in order

1. **Finish T0.** One of its files is written:
   `src/lib/account-offboarding/__tests__/stripe-customer-redaction.test.ts`
   (10 tests, with a fake that applies Stripe's real metadata MERGE semantics —
   keep that; a replacement-model fake proves nothing). The remaining 35 titles
   are listed in the intake's `tests_to_add`, and the plan's tracer table says
   which tracer owns which count: T0 1, T1 10, T2 13, T3 6, T4 15.

   **No `.todo`, no `.skip`, no conditional skip.** A pending test cannot make
   `vitest run` fail, so it is not a promise. Title 38 is the meta-check that
   enforces this.

2. **T1** — `src/lib/account-offboarding/stripe-customer-redaction.ts` plus its
   `docs/directory.md` row. Runs ALONE: it carries the first-task enforcement
   spot check (diff `git status --porcelain` against `allowed_edit_surface`; an
   out-of-surface file means enforcement did not bind — stop and report).

3. **T2, T3, T4.** T2 is blocked by T1. T3 and T4 are disjoint from everything
   and from each other, so they may run concurrently with T2.

4. Gate, deviations read-back, review wave, red team, staging, PR.

## Gate

Currently RED on `feature-surface` only, and that is CORRECT: the intake names
`src/lib/account-offboarding/stripe-customer-redaction.ts`, which T1 creates.
The audit's own message names this case. It goes green when T1 lands.

**Do not run per-path `pnpm test <dir>` as `verification_commands`.** That was
deviation D2: the gate runs its `extra-*` rows in parallel, and concurrent
vitest processes against one Postgres test database interfere. The gate's own
`pnpm test` row already covers every suite with the right serialization.
`verification_commands` is deliberately empty.

## Two things this session got wrong

Recorded so a resumed session does not repeat them.

1. I told the owner the acked webhook event stayed "operator-replayable". It
   did not. Round 2 disproved it and D9 changed as a result.
2. I estimated the D8 lock as "two call sites, one file" when six
   transaction-opening callers existed. Placing the lock in the internal
   function restored the small footprint, but the estimate was wrong when the
   owner made the decision on it.

Codex asserted twice that `worker/jobs/account-offboarding` has a pre-existing
test failure. It does not: 88/88 pass when the suite runs alone with
`TEST_DATABASE_POOL_URL` exported. That red was deviation D2, now removed.
