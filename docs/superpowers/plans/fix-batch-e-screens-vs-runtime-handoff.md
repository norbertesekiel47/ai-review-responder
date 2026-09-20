# Handoff — fix/batch-e-screens-vs-runtime

Batch E: three screens that contradict the runtime.
Issues **#1314** (auto-approval headline), **#1054** (billing plan-switch
labels, P1), **#1173** (worker boot flag line).

## Where to read, by path — never restate these here

| Artifact | Path |
|---|---|
| Locked intake | `docs/superpowers/plans/fix-batch-e-screens-vs-runtime-intake.json` |
| Plan (3 tracers + review appendix) | `docs/superpowers/plans/fix-batch-e-screens-vs-runtime-plan.md` |
| Deviations | `docs/superpowers/plans/fix-batch-e-screens-vs-runtime-deviations.md` |
| Machine state | `.feature/state.json` |
| Ladder | `.feature/progress.json` |
| Glossary (**Posting block** lands here) | `docs/context/core-reviews-responses.md` |
| Plan-gate raw output | `.feature/plan-skeptic-round{1,2}.jsonl` |

Worktree root: `/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/fix-batch-e-screens-vs-runtime`.
Every Write/Edit path must point there, never at the parent checkout.

## State at handoff

- Phase `plan_approved`. Classification `standard` / `high` / `mixed`.
- Plan rounds: **2 of 3 spent**, both Codex `gpt-6-astra`, read-only.
  Round-1 session id **`01a0bd0d-c297-7a93-99ae-af4aa2da01e9`** — resume this
  for any further plan verification; never start one cold.
- Contract: 53 test titles, 16 edge cases, 26 surface entries.
- Surface amendments: **1 of 1 used** (`src/lib/agents/operator/__tests__/context.test.ts`,
  forced by typecheck). A second needs `--reason`.
- Nothing implemented. No code file touched.

## The three things most likely to be got wrong

1. **The purchasability trap.** `autopilot_unavailable` is
   `tierGrantsAutopilot(tier) && autopilotPurchasable()`. An Autopilot account
   with `AUTOPILOT_PURCHASABLE=false` carries that reason **and still posts**.
   Never key the headline on it. The loader test
   `…autopilot account whose sale is paused` is the one that catches this.
2. **`judge_disabled` is a Posting block; Judge *health* is not.** Invariant #3
   makes `JUDGE_ENABLED=false` a posting precondition, and production runs in
   exactly that state. `isJudgeHealthy` is three fleet-wide queries and stays
   out — decision and residual gap are in the plan's review appendix, and the
   gap must be named in the PR description.
3. **`canTurnOff: account.threshold !== null`**, not `true`. `set_account_manual`
   clears only the account default, so offering it for an override-only policy
   is an action that does nothing.

## Next step

Step 4. T1 runs **first and alone** — its completion is the enforcement spot
check. T2 and T3 are mutually independent and may then run as concurrent
subagents in one message.

## Phase cost

_(populated at step 8 by `phase-cost.mjs`)_
