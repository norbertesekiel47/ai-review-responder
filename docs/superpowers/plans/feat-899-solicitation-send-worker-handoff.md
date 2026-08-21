# Handoff — #899 Solicitation send worker

Written at the step 3→4 boundary. A resumed session bootstraps from this file and
never needs the prior transcript. Everything below is a POINTER, not a restatement.

## Where things are

| Artifact | Path |
|---|---|
| Worktree root | `/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-899-solicitation-send-worker` |
| Branch | `feat-899-solicitation-send-worker` (from `main` @ `9e60617c`) |
| Ticket | `gh issue view 899` — plus its single comment, which carries the #898 follow-on facts |
| Intake contract (audit copy) | `docs/superpowers/plans/feat-899-solicitation-send-worker-intake.json` |
| Intake contract (arming copy) | `.feature/intake.json` (gitignored by design) |
| Plan | `docs/superpowers/plans/2026-08-21-899-solicitation-send-worker.md` |
| Plan review findings | `docs/reviews/feat-899-solicitation-send-worker/plan-review-self.md` |
| Machine state | `.feature/state.json` |
| Deviations (create on first entry) | `docs/superpowers/plans/feat-899-solicitation-send-worker-deviations.md` |

Governing docs and the locked glossary terms are listed in the plan's
"Governing documents" table. Do not re-derive them here.

## Status

- Step 0 classify: **done** — `high` / `backend` / `db_touching: false`, est. 950 prod + 1500 test lines.
- Step 1 grill: **done** — 8 decisions locked (plan §"The eight locked decisions"), 0 open questions, owner signed off.
- Step 2 setup: **done** — worktree ARMED, no cross-worktree surface overlap.
- Step 3 plan: written and committed. Review rounds used: **3 of 3** (`planReviewRounds=3`).
- Step 4 execute: **not started.**

## Verified prerequisites (do not re-check)

- Local test DB is at migrations head 110: `solicitation_outreach.bounce_kind` and
  `solicitation_send_breaker` both present. **`pnpm test:db:setup` is NOT needed.**
- `TEST_DATABASE_POOL_URL` and `DATABASE_POOL_URL` are both present in the worktree's
  `.env.local`, so the gate resolves them itself.
- The live `solicitation_outreach_status_reason_consistency` CHECK carries
  `no_postal_address` and `postal_address_mismatch`, and carries **no `flag_off` member** —
  which is what forces locked decision 5 (a flag-off defers, it never terminalizes).
- `agent_run_steps.step_key` has **no DB CHECK**, so the two new step keys need no migration.
- Every signature the plan cites is verified present:
  `lockDispatchedOutboxAttemptIfOwned(exec, outboxId, attempt)`,
  `acquireSolicitationBatchLock(tx, businessId)`,
  `deriveBatchState(row, now)`,
  `markOutboxCompletedIfOwned(exec, outboxId, attempt?)`,
  `completeRun(tx, runId, status, error?)`,
  `startOrGetSolicitationAskRun(tx, input)`,
  `recordOutcome(tx, input)`,
  `normalizeEmail(raw)`,
  `import { v7 as uuidv7 } from 'uuid'`.

## Known plan corrections to apply before executing

From `plan-review-self.md`. Two are correctness bugs, not test gaps:

1. **S2** — `tx1` must open with `lockDispatchedOutboxAttemptIfOwned`, then
   `acquireSolicitationBatchLock`, then the batch row `FOR UPDATE`, then
   `deriveBatchState` — the exact order at `src/lib/solicitation/ask-generation.ts:988`.
   Without the first call a stale attempt can reach the provider alongside a live one.
2. **S1** — add the re-dispatch idempotency test named by executor design line 1136.
3. Cited path correction: `abort-injection.ts` is at
   `src/lib/shared/__tests__/helpers/abort-injection.ts`, not under `src/lib/solicitation/`.
4. Six additional test titles (see the findings file) are a `tests_to_add` extension,
   recorded as an owner-approved deviations entry — **not** an `allowed_edit_surface`
   amendment, so they do not count toward the abort budget.

## Tooling trap learned this session

`timeout` and `gtimeout` are **not installed** on this machine. A command wrapped in
`timeout N …` fails instantly with exit 127 and can look like a fast, clean return.
Bound waits with the Bash tool's own `timeout` parameter or a Monitor until-loop.

## Next action

Apply the corrections above to the plan, then step 4: `feature-state.sh set-phase executing`
and dispatch Task 0 (the eval task), then Task 1 **alone** for the first-task enforcement
spot check.
