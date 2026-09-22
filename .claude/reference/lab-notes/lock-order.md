# Lab notes — Lock order

## Summary

- **Lock order** — the single owner of the cross-owner row-lock order for the review lane (`reviews → businesses → responses/children → accounts`) and the location/account lane (`businesses → accounts`); the owner-approval lane is the ONE documented exception (`responses → businesses FOR SHARE`), safe only because it is disjoint from the Judge lane, not because the two orders agree (#1380, 2026-09-22)

## Canonical entries

### Lock order

Every lock-site comment in the files below points here instead of restating the order. Lane-local orders that never touch these tables keep their own owner (solicitation `batch → run`: `src/lib/solicitation/approval.ts` header; run spine "review row first": `src/lib/agents/run-spine.ts` header; billing `business → entitlement → account`: `src/lib/accounts/billing-locks.ts`).

**The implicit-FK-lock rule.** An `INSERT` (or key `UPDATE`) on a child row takes `FOR KEY SHARE` on every parent row its foreign keys reference. "Lock X before Y" therefore means before ANY statement that takes an implicit lock on Y, not just before the explicit `FOR UPDATE` on Y. Taking the parent `FOR UPDATE` first also prevents a share → exclusive upgrade later in the same transaction, which deadlocks (40P01) against a peer holding the same `KEY SHARE`. Worked examples: `worker/jobs/response-generation/auto-approval.ts` (business lock before the count), `worker/jobs/response-generation/persist.ts` (review lock before the responses INSERT).

**Review lane — the global order.**

| Step | Row | Strength | Why here |
|---|---|---|---|
| 1 | `reviews` | `FOR UPDATE`, taken by `anchorReviewLockOrder` (`src/lib/approval/outcomes.ts`) after an unlocked pre-read | First lock of the transaction; serializes every lane that later writes `agent_runs` children |
| 2 | `businesses` | `FOR UPDATE`, explicit | Must precede the implicit businesses `KEY SHARE` of any child `INSERT` (verdict, audit, outcome) |
| 3 | `responses` and other children | `FOR UPDATE` | — |
| 4 | `accounts` | `FOR UPDATE` (`lockAutonomyAccount`, flag verdicts and suspensions only) | Last. Taken before the child `INSERT` whose `accounts` FK would otherwise leave a `KEY SHARE` to upgrade |

Sites: `worker/jobs/judge/JudgeWorker.ts`, `worker/jobs/judge/failed-hook.ts` (steps 1–2 only, then the verdict `INSERT`'s implicit locks; never step 4), `worker/jobs/publisher/auto-policy-downgrade.ts`, `worker/jobs/publisher/failed-hook.ts` (`lockPublisherFailureLane`, then `job_outbox`), `worker/jobs/response-generation/persist.ts` (auto-approval candidates: `reviews → businesses → entitlement`). Source pins: `worker/jobs/judge/__tests__/lock-order-source.test.ts`, `worker/jobs/publisher/__tests__/auto-policy-downgrade-lock-order.test.ts`.

**The exception — owner-approval lane: `responses FOR UPDATE → businesses FOR SHARE`.** `lockPendingResponse` (`src/lib/approval/locks.ts`) locks the response, then calls `assertLocationNotArchived` (businesses `FOR SHARE`) so a concurrent archive, which takes businesses `FOR UPDATE`, is seen with no TOCTOU window. Approve/edit take the review anchor first; regenerate lanes take none. This is the opposite of steps 2–3 above. It cannot deadlock with the Judge lane because the two never wait on the same response row:

- `lockPendingResponse` reaches the businesses lock only after reading `status = 'pending_approval'` under its own row lock. Any other status throws first.
- The Judge lane proceeds only on `isPostedAutoPolicyResponse` (`worker/jobs/judge/context.ts`: `status = 'posted'` AND `approval_method = 'auto_policy'`). A Judge job exists only for a response already posted: `JudgeSweepPoller` enqueues from `listUnjudgedAutoPosts` (`src/lib/responses/judge-store.ts`, same predicate). The failed hook locks no response explicitly, but its verdict `INSERT`'s `responses` `KEY SHARE` conflicts with `FOR UPDATE`, so the same argument covers it.
- A posted response never returns to `pending_approval`. The only writers that set `pending_approval` on an existing row are `vetoAutoPost` (`src/lib/approval/veto.ts`, from `approved`) and the kill-switch downgrade (`auto-policy-downgrade.ts`, from `approved`/`edited`/`awaiting_owner_connect`). Re-verify both before adding a third.

For approve/edit, the shared review anchor also serializes the two lanes before either reaches a response. Regenerate has no anchor, so it relies on the status argument alone. The downgrade and publisher-failure lanes target publish-lane responses; nobody has proved that they can never wait on a `pending_approval` row an anchor-less regenerate holds. Treat that pair as not proved.

**Admin flagged-disposition lane** (`src/app/api/admin/flagged/route.ts`, `requires_regeneration`): `flagged_responses FOR UPDATE → responses FOR UPDATE → businesses FOR SHARE`, with no status check before the businesses lock. It is safe only because of invariant #4: a high-severity flagged draft is held, never auto-approved, so it is never `auto_policy`, and no review-lane transaction (Judge, downgrade) targets it while its flag is open. **A future lane that both dispositions a flag and touches a posted auto-policy response closes the cycle.** Such a lane must take the review-lane order instead.

**Location/account lane: `businesses → accounts`**, consistent everywhere. Archive and reactivate (`src/lib/locations/archive-location-tx.ts`) and promote (`promote-primary-tx.ts`) run lifecycle advisory lock → businesses rows `FOR UPDATE` (ordered by id) → `accounts FOR UPDATE`. Never hold `accounts` while waiting on a business row. Publisher/mirror paths hold `business → entitlement`, and tier/status writers hold `entitlement → account`. The Judge lane's step 4 follows the same half.

**Owner Operator: Restore vs Apply.** Restore preparation (`lockRestoreScope`, `src/lib/agents/operator/restore.ts`) takes `businesses FOR NO KEY UPDATE → accounts FOR NO KEY UPDATE`. Apply (`src/lib/agents/operator/apply.ts`) has two domains:

- **Voice** takes `businesses FOR UPDATE → agent_proposals`.
- **Policy** takes `accounts FOR UPDATE` (`lockAutonomyAccount`) `→ agent_proposals`, and reads `businesses` unlocked (`policy-state.ts`).

Each Apply domain conflicts with Restore on exactly one parent, the first one it locks, so the two serialize there and neither holds a lock the other takes second. Neither Apply domain takes a conflicting lock on Restore's other parent. `NO KEY UPDATE`, not `FOR UPDATE`, is deliberate: it still admits the implicit FK `KEY SHARE` that `createTurn`'s child inserts take on the same parents. Never upgrade Restore's parents through an Apply/settings lock helper.

## History

- `.claude/reference/arch-review-log.md` § "2026-09-20 — Architecture pass", agenda item 3 "Cross-owner lock ordering" (the finding) and the #1380 line (this owner).
