# SolicitationReleasePoller Implementation Plan (#900)

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the one Postgres-state-driven loop that releases approved **Outreach rows** through the fixed governor order, writes the two system **Halt latch** reasons, terminalizes wedged `sending` rows as `unknown`, and backstops the join.

**Architecture:** One deep domain module `src/lib/solicitation/release.ts` exports exactly one function, `runReleaseCycle(sql, options?)`. It owns the phase order, which is a domain rule. Four phases run inside it: the `unknown` sweep, the two expiry sweeps, the release phase, then the backstop join. `worker/background/pollers/SolicitationReleasePoller.ts` is a deliberately shallow adapter — `createGuardedPoll` plus the `sql` singleton, no rules.

**Tech Stack:** Postgres.js (`Sql` / `TransactionSql`), BullMQ via `job_outbox`, vitest, fast-check.

**Contract:** `.feature/intake.json`. Governing docs: `docs/superpowers/specs/2026-07-28-send-mode-executor-approval-design.md` §4 D7/D9/D10, §5 D11/D12/D14, §7 D18; `docs/superpowers/specs/2026-07-28-send-mode-cross-spec-amendments.md` B3/B7/B10/B14/B15 (amendments win on conflict).

---

## Locked decisions from grilling

| # | Decision |
|---|---|
| 1 | B14's `platform_halt` gap is DEFERRED to a new issue. This PR ships no migration. |
| 2 | The release phase checks `SOLICITATION_SEND_ENABLED`. No row reaches `queued` under a flag-off. |
| 3 | `latchHalt` gains a third arm `latchSystemHalt`; `actorUserId` widens to `string \| null`. |
| 4 | A Judge downgrade writes a spine step and a Sentry warning. No owner notification. |
| 5 | `UNKNOWN_GRACE_MINUTES = 60`, hardcoded, anchored on `solicitation_outreach.sending_at`. |
| 6 | `solicitation_batches.sending_started_at` is stamped in the first release transaction, CAS on NULL. |
| 7 | Drip pacing is a per-tick release budget. True yield-to-transactional is not built. |
| 8 | The flag gates the RELEASE PHASE ONLY. The three sweeps and the backstop run on every tick. |

**Decision 8 departs from the `JudgeSweepPoller` precedent deliberately.** If the whole poller were flag-gated, flipping `SOLICITATION_SEND_ENABLED` off mid-drip would stop the `send_window_elapsed` sweep, so 091's one-active-send index would block that location forever. State this reason in the poller's header comment.

## File structure

| File | Responsibility |
|---|---|
| `src/lib/solicitation/release.ts` | **NEW.** One export, `runReleaseCycle`. Owns the phase order, the four predicates, the governor order, the Judge split, the per-tick budget. |
| `src/lib/solicitation/approval.ts` | **MODIFY.** Widen `LatchHaltInput.actorUserId` to `string \| null`. Add exported `latchSystemHalt`. Pin the `latchHalt` CAS. |
| `src/lib/solicitation/outreach.ts` | **MODIFY.** Add `UNKNOWN_GRACE_MINUTES = 60` beside `BATCH_SEND_WINDOW_HOURS`. |
| `src/lib/shared/job-outbox-helpers.ts` | **MODIFY.** Add `enqueueSolicitationSend`. |
| `src/lib/config/worker.ts` | **MODIFY.** Add `SOLICITATION_RELEASE_POLL_INTERVAL_MS: rawOpt`. |
| `worker/background/pollers/SolicitationReleasePoller.ts` | **NEW.** Shallow adapter. |
| `worker/index.ts` | **MODIFY.** Import and register start/stop. |

## Interfaces, stated once

```ts
// src/lib/solicitation/release.ts

/** Which release-level gate stopped a release. Closed union; no other member. */
export type ReleaseWithheldReason =
  | 'flag_off'
  | 'breaker_open'
  | 'platform_ceiling'
  | 'account_cap'
  | 'subscription'
  | 'judge_unhealthy'
  | 'per_tick_budget';

export interface ReleaseCycleReport {
  released: number;
  /** The FIRST gate that stopped the whole release phase, or null when it ran. */
  releasePhaseStoppedBy: ReleaseWithheldReason | null;
  /** Per-account and per-batch withholds, counted by reason. */
  withheldByReason: Partial<Record<ReleaseWithheldReason, number>>;
  downgraded: number;
  heldForJudge: number;
  sendWindowElapsed: number;
  batchExpired: number;
  unknownTerminalized: number;
  backstopClosed: number;
}

export interface ReleaseCycleOptions {
  /** Platform-wide rows released per tick. Default RELEASE_PER_TICK_BUDGET. */
  perTickBudget?: number;
  /** Candidate batches scanned per phase. Default 50. */
  scanLimit?: number;
}

export const RELEASE_PER_TICK_BUDGET = 2;

export async function runReleaseCycle(
  sql: Sql,
  options?: ReleaseCycleOptions,
): Promise<ReleaseCycleReport>;
```

```ts
// src/lib/solicitation/approval.ts — the third arm
export type SystemHaltReason = 'send_window_elapsed' | 'batch_expired';

export interface LatchSystemHaltInput {
  batchId: string;
  accountId: string;
  businessId: string;
  reason: SystemHaltReason;
}

export type LatchSystemHaltResult =
  | { status: 'not_latched' }
  | { status: 'latched'; cancelledCount: number; close: CloseBatchIfSettledResult };

/** Caller MUST already hold the batch row lock. */
export async function latchSystemHalt(
  tx: TransactionSql,
  input: LatchSystemHaltInput,
): Promise<LatchSystemHaltResult>;
```

```ts
// src/lib/shared/job-outbox-helpers.ts
export interface EnqueueSolicitationSendInput {
  outreachId: string;
  batchId: string;
  businessId: string;
  correlationId?: string;
  outboxId?: string;
}

/** Returns the outbox id, or null when an in-flight row already exists. */
export async function enqueueSolicitationSend(
  tx: TxClient,
  input: EnqueueSolicitationSendInput,
): Promise<string | null>;
```

## The four predicates, stated once

Every `status IN (...)` list below is spelled by hand, members and order, per `src/lib/shared/job-outbox-status.ts`. `ci:outbox-status` checks it.

**P1 — `unknown` sweep (D12d).** Both belts: the grace period AND the absence of an in-flight outbox row.

```sql
SELECT o.id, o.account_id, o.business_id, o.batch_id
  FROM solicitation_outreach o
 WHERE o.delivery_status = 'sending'
   AND o.sending_at <= NOW() - make_interval(mins => 60)
   AND NOT EXISTS (
     SELECT 1 FROM job_outbox jo
      WHERE jo.topic = 'solicitation_send'
        AND jo.aggregate_id = o.id
        AND jo.status IN ('pending', 'dispatching', 'dispatched')
   )
 ORDER BY o.sending_at ASC
 LIMIT $1
```

**P2 — `send_window_elapsed` sweep.**

```sql
SELECT id, account_id, business_id
  FROM solicitation_batches
 WHERE approved_at IS NOT NULL
   AND approved_at <= NOW() - make_interval(hours => 72)
   AND halted_at IS NULL
   AND send_closed_at IS NULL
 ORDER BY approved_at ASC
 LIMIT $1
```

**P3 — `batch_expired` sweep (B7).** The `EXISTS` over `agent_runs` is what B7 means by "that have a Send batch parent". Without it a watch-mode batch is latched.

```sql
SELECT b.id, b.account_id, b.business_id
  FROM solicitation_batches b
 WHERE b.approved_at IS NULL
   AND b.built_at IS NOT NULL
   AND b.built_at <= NOW() - make_interval(days => 7)
   AND b.halted_at IS NULL
   AND b.send_closed_at IS NULL
   AND EXISTS (
     SELECT 1 FROM agent_runs r
      WHERE r.kind = 'solicitation_send_batch'
        AND r.subject_type = 'solicitation_batch'
        AND r.subject_id = b.id::text
        AND r.account_id = b.account_id
        AND r.business_id = b.business_id
   )
 ORDER BY b.built_at ASC
 LIMIT $1
```

**P4 — release candidates.** `veto_deadline_at IS NOT NULL` is D9's fail-closed rule: no deadline means never released. The `approved_at >` arm is belt-and-braces behind P2.

```sql
SELECT b.id, b.account_id, b.business_id, b.sending_started_at
  FROM solicitation_batches b
 WHERE b.approved_at IS NOT NULL
   AND b.halted_at IS NULL
   AND b.send_closed_at IS NULL
   AND b.veto_deadline_at IS NOT NULL
   AND NOW() >= b.veto_deadline_at
   AND b.approved_at > NOW() - make_interval(hours => 72)
   AND EXISTS (
     SELECT 1 FROM solicitation_outreach o
      WHERE o.batch_id = b.id
        AND o.account_id = b.account_id
        AND o.business_id = b.business_id
        AND o.delivery_status = 'rendered'
   )
 ORDER BY b.approved_at ASC
 LIMIT $1
```

## Phase order inside `runReleaseCycle`

The order is the contract, not an implementation detail.

1. **`unknown` sweep (P1).** First, so a wedged row can settle its batch this same tick.
2. **`send_window_elapsed` sweep (P2).** Before release, so an overdue batch never releases.
3. **`batch_expired` sweep (P3).**
4. **Release phase.** Flag-gated. Governors in the fixed order.
5. **Backstop join.** `closeBatchIfSettled` over every still-open batch the tick saw.

Phases 1, 2, 3 and 5 run regardless of `SOLICITATION_SEND_ENABLED` (decision 8).

## Governor order in the release phase

Checked once per tick, in this order, each stopping the whole phase:

1. `solicitationSendEnabled()` — the master switch. Cheapest, and it asks "does this feature exist".
2. `readSendBreaker(sql)` — **no try/catch**. The throw IS the halt signal (invariant, `CONTEXT.md` **Send breaker**).
3. `resolvePlatformDailyCap(getWorkerConfig().SOLICITATION_PLATFORM_DAILY_CAP)` minus `countPlatformDispatchAttemptsToday(sql)`. Zero or less stops the phase.

Then per account, in this order:

4. `subscriptionGrantsFullAccess(status)` (B14).
5. `resolveAccountDailySendCap(policy)` minus `countAccountDispatchAttemptsToday(sql, accountId)`.

Then, and only then, per batch:

6. The **Judge split** — `judgeEnabled()` and `isJudgeHealthy(sql)`, both read once per tick.

**The Judge is evaluated LAST, and that position is load-bearing** (round-1 finding 2). A
downgrade is a destructive write: it clears `approved_at`, `approval_method` and
`approved_by_user_id`. Evaluating it before the account cap would destroy the approval
evidence of a batch the cap alone would simply have stopped. The rule is: only a batch
that has passed every other gate and still has capacity to release may be downgraded.

**Remaining capacity DECREMENTS inside the tick** (round-1 finding 11). Both the platform
remainder and each account's remainder are held as running counters and decremented on
every successful release. A single check at the top of the phase lets a two-row tick
overrun a ceiling that had one slot left.

The per-child **Dispatch gate** is #899's and runs nowhere in this file.

---

# Tasks

Blocking edges are stated per task. **Tasks 1 and 2 are mutually independent** — no edges between them and disjoint file sets. Every task from 3 onward edits `release.ts` and is therefore serial.

---

## Task 0 — Eval task: the failing tests (the spec in executable form)

**Blocking edges:** none. Must land before any implementation task.

**Files:**
- Create: `src/lib/solicitation/__tests__/release.test.ts`
- Create: `src/lib/solicitation/__tests__/release.integration.test.ts`
- Create: `src/lib/solicitation/__tests__/approval-system-halt.integration.test.ts`
- Modify: `src/lib/shared/__tests__/job-outbox-helpers.test.ts`
- Create: `worker/background/pollers/__tests__/SolicitationReleasePoller.test.ts`

Author all **38** titles from `.feature/intake.json` `tests_to_add`, **verbatim**. The gate's `promised-tests` row matches them literally. A slice not yet buildable uses `it.todo(...)`; a later task converts it.

Eleven of the 38 came from the round-1 adversarial review, which found the original 27
could all pass while the feature was still unsafe. Each closes a named silent-failure
mode; none is optional.

- [ ] **Step 1: Read the precedents before writing a line**
  - `src/lib/solicitation/__tests__/outreach-close.integration.test.ts` — live-DB seeding for batches, outreach and the send parent.
  - `src/lib/solicitation/__tests__/send-caps.integration.test.ts` — the UTC-day counting fixtures.
  - `src/lib/reviews/__tests__/sentiment.test.ts` — the `fast-check` house style, in an `invariants` describe block.

- [ ] **Step 2: Place each title in the right file**

| File | Titles |
|---|---|
| `release.integration.test.ts` | The 12 release titles, the 2 Judge titles, the 4 sweep titles, `does not latch batch_expired on a batch with no Send batch parent`, the 2 `unknown` titles, `runs the sweeps and the backstop while SOLICITATION_SEND_ENABLED is off`, `closes a settled batch the inline path missed`, plus these nine from round 1: `never releases an approved batch with a NULL veto_deadline_at`, `does not downgrade a cap-exhausted batch when the Judge is unhealthy`, `propagates a Send breaker read failure and enqueues no solicitation_send row`, `rolls back rendered-to-queued when enqueueSolicitationSend throws`, `does not terminalize a sending row whose outbox row is re-pended after selection`, `terminalizes the lazy child run in the same transaction as the unknown outreach row`, `does not clear approval when a concurrent Halt latch wins the batch lock`, `does not release when the send window elapses while waiting for the batch lock`, `treats JUDGE_ENABLED false exactly as an unhealthy Judge`, `releases no more than the remaining platform capacity in one tick` |
| `release.test.ts` | `property: the account daily send cap is never exceeded across arbitrary release sequences` |
| `approval-system-halt.integration.test.ts` | `latchSystemHalt writes a NULL halted_by and no account_audit_log row`, `a second system halt on an already halted batch writes nothing`, `latchSystemHalt never cancels a sending Outreach row`, `property: the Halt latch is monotone under arbitrary halt orderings` |
| `job-outbox-helpers.test.ts` | `enqueueSolicitationSend returns null when an in-flight solicitation_send row already exists` |
| `SolicitationReleasePoller.test.ts` | Loop mechanics only — start, stop, single-flight. No domain assertions. |

- [ ] **Step 3: Obey the live-DB conventions**
  - A live-DB suite is named `*.integration.test.ts`. Never execute DDL at run time — call `assertSchemaReady` instead. `ci:live-db-suites` enforces both.
  - Seed `timestamptz` fixtures with `+ interval '419 microseconds'` where a row is compared against a window derived from that row (#520).

- [ ] **Step 4: Run and confirm every test fails or is todo**

```bash
cd /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-900-solicitation-release-poller && pnpm vitest run src/lib/solicitation/__tests__/release.test.ts
```
Expected: FAIL — `runReleaseCycle` is not exported.

- [ ] **Step 5: Commit**

```bash
git add src/lib/solicitation/__tests__ src/lib/shared/__tests__ worker/background/pollers/__tests__
git commit -m "test(900): eval task — 27 failing tests for the release poller"
```

---

## Task 1 — `enqueueSolicitationSend` typed helper (B10)

**Blocking edges:** Task 0.
**Turns green:** `enqueueSolicitationSend returns null when an in-flight solicitation_send row already exists`.
**Mutually independent with Task 2.**

**Files:** Modify `src/lib/shared/job-outbox-helpers.ts`.

- [ ] **Step 1: Copy the shape from the precedent in the same file**

`enqueueGenerateSolicitationAsks` (same file) is the dedup-variant precedent: `ON CONFLICT ... DO NOTHING ... RETURNING id`, returning the id or `null`.

- [ ] **Step 2: Write the helper**

`aggregate_type` is `'solicitation_outreach'`, `aggregate_id` is the **outreach id** — migration 091's stated contract, not the batch id. Payload is `SolicitationSendPayload` from `src/lib/shared/worker-types.ts`: `batch_id`, `business_id`, `outreach_id`, plus optional `correlation_id`.

The `ON CONFLICT` predicate is byte-for-byte with `job_outbox_solicitation_send_inflight` in `supabase/migrations/091_send_mode_spine_lifecycle.sql:541`:

```sql
ON CONFLICT (topic, aggregate_id)
WHERE topic = 'solicitation_send' -- topic-audit-ignore: partial-index inference needs a literal
  AND status IN ('pending', 'dispatching', 'dispatched')
DO NOTHING
RETURNING id
```

- [ ] **Step 3: Verify the seam audits pass**

```bash
pnpm ci:outbox-status && pnpm ci:outbox-seam && pnpm ci:outbox-topics
```
Expected: all PASS. `ci:outbox-seam` now forbids any raw `solicitation_send` INSERT anywhere.

- [ ] **Step 4: Run the test, then commit**

---

## Task 2 — `latchSystemHalt`, the third arm

**Blocking edges:** Task 0.
**Turns green:** `latchSystemHalt writes a NULL halted_by and no account_audit_log row`, `a second system halt on an already halted batch writes nothing`, `latchSystemHalt never cancels a sending Outreach row`, `property: the Halt latch is monotone under arbitrary halt orderings`.
**Mutually independent with Task 1.**

**Files:** Modify `src/lib/solicitation/approval.ts`.

- [ ] **Step 1: Widen the actor type**

`LatchHaltInput.actorUserId` becomes `string | null`. Migration 091's `solicitation_batches_halt_consistency` CHECK already requires `halted_by IS NULL` for exactly `send_window_elapsed` and `batch_expired`, so this type change makes the signature express a rule the database already enforces.

- [ ] **Step 2: Add the arm**

`latchSystemHalt` passes `actorUserId: null` and `audit: null`. It does NOT call `lockBatchForAction` — there is no owner request to authorize. The caller holds the batch lock.

It derives `state` for the `batch_halted` step detail from `deriveBatchState`, exactly as the two owner arms do.

- [ ] **Step 3: Pin the CAS — this is load-bearing**

Issue #895(b) proves `latchHalt`'s `AND halted_at IS NULL` is unreachable through both existing arms, because each refuses at `state === 'halted'` first. `latchSystemHalt` skips that guard, so the CAS becomes the only defense. The property test in Step 4 is what pins it.

Verify by deleting `AND halted_at IS NULL` and confirming the new property test goes RED. Restore it.

- [ ] **Step 3b: Prove the `sending` exclusion** (round-1 finding 9)

`latchSystemHalt never cancels a sending Outreach row` seeds one row in each of `rendered`,
`queued` and `sending`, latches, and asserts the first two are `cancelled` and the third is
untouched. Cancelling a `sending` row would discard a real provider delivery from lifecycle
accounting, so a later batch could treat that contact as unsent and email them again.

The same test asserts the `batch_halted` step detail names the system reason and carries
`halted_by: null`, so the receipt is truthful about an actor-less halt.

- [ ] **Step 4: Write the property test**

`fast-check` over arbitrary orderings of two or more halts on one batch. Property: after any ordering, `halted_at` and `halt_reason` equal the FIRST halt's values, exactly one `batch_halted` step exists, and at most one `account_audit_log` row exists.

- [ ] **Step 5: Run, then commit**

---

## Task 3 — `release.ts` and the release phase (the tracer bullet)

**Blocking edges:** Task 1 (needs the helper), Task 2 (imports `latchSystemHalt`'s module; no behavioural dependency).

**Turns green:** the 12 release titles, `downgrades an approved batch to owner review when the Judge is unhealthy before the first release`, `holds with no state change when the Judge is unhealthy mid-drip`, `property: the account daily send cap is never exceeded across arbitrary release sequences`.

**Files:** Create `src/lib/solicitation/release.ts`; modify `src/lib/solicitation/outreach.ts` (add `UNKNOWN_GRACE_MINUTES = 60`).

This is the thin vertical slice that runs end to end: predicate → governors → transaction → outbox row.

- [ ] **Step 1: Write the module header**

State the phase order, the governor order, and decision 8's departure from the `JudgeSweepPoller` precedent. A reader must learn the order from the file, not from this plan.

- [ ] **Step 2: Implement `runReleaseCycle` with ONLY the release phase**

Sweeps are `// Task 4/5/6` stubs returning 0. The backstop is a `// Task 7` stub. The phase order scaffold is in place from the first commit.

- [ ] **Step 3: Implement the governors in the fixed order**

Use the module list above. **`readSendBreaker` gets no try/catch** — the throw propagates and the tick fails, which IS the halt.

- [ ] **Step 4: Implement the Judge split — LAST, after every other gate**

Judge availability is unavailable when **either** `judgeEnabled()` is false **or**
`isJudgeHealthy(sql)` is false. D18 requires both to fail closed. Read both ONCE per tick.

Apply the split ONLY to a batch that has passed the flag, the breaker, the platform
ceiling, the subscription check and the account cap, and that still has remaining capacity
this tick. See the governor-order section for why.

- `sending_started_at IS NULL` → downgrade in its own transaction: lock the batch row, then
  ```sql
  UPDATE solicitation_batches
     SET approved_at = NULL, approval_method = NULL,
         approved_by_user_id = NULL, veto_deadline_at = NULL
   WHERE id = $1 AND account_id = $2 AND business_id = $3
     AND approved_at IS NOT NULL
     AND sending_started_at IS NULL
     AND halted_at IS NULL
     AND send_closed_at IS NULL
  ```
  then `recordStep(tx, { runId: sendParentRunId, stepKey: 'approval_downgraded', detail: { reason: 'judge_unavailable' } })`, then a Sentry warning.
- `sending_started_at IS NOT NULL` → hold. **No writes at all.** Count into `heldForJudge`.

**The `halted_at IS NULL AND send_closed_at IS NULL` arms are load-bearing** (round-1
finding 7). A **Halt latch** does NOT clear `approved_at`. Without those two arms, a
candidate that waited on the batch lock while an owner halted the batch would still match:
it would erase the approval evidence of an already-terminalized batch and append a false
`approval_downgraded` receipt after the fact.

Migration 091's `solicitation_batches_send_ordering` CHECK (`sending_started_at IS NULL OR approved_at IS NOT NULL`) makes a mid-drip downgrade impossible at the database. Do not branch around it — if the CAS above ever matched a row with `sending_started_at` set, the database would reject the statement.

- [ ] **Step 5: Implement the release transaction, one per Outreach row**

```
sql.begin(async (tx) => {
  // 1. lock the batch row, re-read halted_at / send_closed_at / approved_at
  //    AND re-assert the 72h send window: approved_at > NOW() - 72h
  // 2. CAS the outreach row
  //      UPDATE solicitation_outreach
  //         SET delivery_status = 'queued', queued_at = NOW(), updated_at = NOW()
  //       WHERE id = $1 AND account_id = $2 AND business_id = $3
  //         AND delivery_status = 'rendered'
  //      RETURNING id
  // 3. stamp sending_started_at, CAS on NULL (decision 6)
  // 4. enqueueSolicitationSend(tx, { ... })
})
```

**Assert, do not branch:** if step 2 returned a row and step 4 returned `null`, throw with the outreach id. A `rendered` row cannot already own an in-flight send job. Defensive handling of a state the invariants exclude hides the real bug.

If step 2 returns no row, another writer changed it — skip and enqueue nothing.

**The 72h re-read in step 1 is load-bearing** (round-1 finding 8). P4 selects candidates
before the tick takes any lock. A candidate that then waits on the batch lock while the
`send_window_elapsed` sweep or a long release runs can become overdue. Re-asserting the
window under the lock is what stops a release after the terminal deadline.

**Atomicity is proved by a forced-failure test, not by inspection** (round-1 finding 4).
`does not release the row when enqueueSolicitationSend throws` injects a helper failure
after the CAS and asserts the row is still `rendered`. Use `src/lib/solicitation/__tests__/helpers/`
or `__tests__/helpers/abort-injection.ts` — never a temporary constraint (`ci:live-db-suites`).
If those two statements ever split across transactions, the row commits `queued` with no
job, and P4 selects `rendered` only: nothing can move it again.

- [ ] **Step 6: Implement the per-tick budget and the capacity decrements**

`RELEASE_PER_TICK_BUDGET = 2`, consumed platform-wide across all batches. On exhaustion, record `per_tick_budget` in `withheldByReason` and stop the phase. Log at warn so the staging ramp can tell "paced" from "capped".

**Three counters decrement per successful release, not once per tick** (round-1 finding 11):
the per-tick budget, the platform remainder, and that account's remainder. Nine prior
attempts against a platform cap of ten leaves ONE slot; a budget-two tick must release one
row, not two.

- [ ] **Step 7: Run the release tests, then commit**

---

## Task 4 — `send_window_elapsed` sweep

**Blocking edges:** Tasks 2, 3.
**Turns green:** `latches send_window_elapsed past the 72h send window and cancels the live Outreach rows`.

**Files:** Modify `src/lib/solicitation/release.ts`.

- [ ] **Step 1: Replace the Task 4 stub with predicate P2**
- [ ] **Step 2: Per batch, in one transaction:** lock the batch row, call `latchSystemHalt(tx, { reason: 'send_window_elapsed', ... })`. The latch owns the cancel, the step and the join. Write nothing else.
- [ ] **Step 3: Run, then commit**

---

## Task 5 — `batch_expired` sweep (B7)

**Blocking edges:** Tasks 2, 3, 4 (same file).
**Turns green:** `latches batch_expired on a never-approved batch past the approval window and closes its parent`, `a batch that receives no approval for 7 days closes cleanly and raises no stalled alert`, `does not latch batch_expired on a batch with no Send batch parent`.

**Files:** Modify `src/lib/solicitation/release.ts`.

- [ ] **Step 1: Replace the Task 5 stub with predicate P3.** The `EXISTS` over `agent_runs` is mandatory — without it a watch-mode batch is latched.
- [ ] **Step 2: Per batch, one transaction:** lock, `latchSystemHalt(tx, { reason: 'batch_expired', ... })`.
- [ ] **Step 3: Prove the no-stalled-alert obligation.** The second test must assert that the batch's Send batch parent reaches a terminal status before `STALLED_THRESHOLD_SEND_BATCH_DAYS = 11`. B7 states this obligation explicitly.
- [ ] **Step 4: Run, then commit**

---

## Task 6 — `unknown` sweep (D12d, the #915 blocker)

**Blocking edges:** Tasks 3, 4, 5 (same file).
**Turns green:** `terminalizes a sending Outreach row as unknown after the grace period when no in-flight outbox row exists`, `does not terminalize a sending row while an in-flight outbox row still exists`.

**Files:** Modify `src/lib/solicitation/release.ts`.

- [ ] **Step 1: Replace the Task 6 stub with predicate P1.** Both belts. `UNKNOWN_GRACE_MINUTES = 60` from `outreach.ts`.
- [ ] **Step 2: Per row, one transaction:** lock the batch row, then
  ```sql
  UPDATE solicitation_outreach o
     SET delivery_status = 'unknown', disposition_reason = 'send_indeterminate',
         updated_at = NOW()
   WHERE o.id = $1 AND o.account_id = $2 AND o.business_id = $3
     AND o.delivery_status = 'sending'
     AND NOT EXISTS (
       SELECT 1 FROM job_outbox jo
        WHERE jo.topic = 'solicitation_send'
          AND jo.aggregate_id = o.id
          AND jo.status IN ('pending', 'dispatching', 'dispatched')
     )
  ```

  **The `NOT EXISTS` is repeated inside the CAS on purpose** (round-1 finding 5). P1 runs
  outside this transaction. The outbox watchdog can re-pend the row between P1's select and
  this UPDATE, and a `delivery_status='sending'` guard alone would then write `unknown` over
  a normal recovery in flight. Zero rows updated means the watchdog won — skip the row.

  091 pairs `unknown` and `send_indeterminate` exclusively. Do not spell either alone.

- [ ] **Step 3: Terminalize the lazy child run in the SAME transaction** (round-1 finding 6)

  `dispatch.ts:1752` creates the **Lazy child** inside tx1, *before* the `sending` CAS. A
  process that died between tx1 and tx2 therefore left BOTH a `sending` Outreach row and a
  `running` child run. Terminalizing only the row leaves the child `running` forever, which
  trips `deriveRunDisplayState`'s 48h `stalled` rule and re-opens the wedge from the spine
  side.

  Call `completeRun(tx, childRunId, 'failed', { … })` with an error naming
  `send_indeterminate`, matching #899's failure arm. **`failed` on the CHILD RUN is not the
  lie D12d forbids** — that lie is about `solicitation_outreach.delivery_status`, which the
  restraint policy's `over_contacted` check reads. Nothing reads `agent_runs` for
  over-contact.

  Write **no** `solicitation_sent` outcome. D12d: `unknown` is not a confirmed send for
  metrics.

  Resolve the child by `subject_type = 'solicitation_ask'` on the outreach row's `ask_id`,
  scoped by account and business. Lock order stays **batch → run** throughout: the batch row
  is locked first, and every `agent_runs` write follows it.

  Then `closeBatchIfSettled(tx, { batchId, accountId, businessId })` last, in the same
  transaction.

- [ ] **Step 4: Raise a Sentry alert per terminalization.** D12d requires it. This row may correspond to a delivered email whose `provider_message_id` was lost — the alert is the only signal.
- [ ] **Step 5: Comment the lie-with-teeth rule at the write site.** On the Outreach row, `failed` would be wrong: the restraint policy's `over_contacted` check reads prior sends, so calling a possible send "not sent" can email that customer twice. State in the same comment why the CHILD RUN may still be `failed`.
- [ ] **Step 6: Run, then commit**

---

## Task 7 — Backstop join and the flag scope

**Blocking edges:** Tasks 3, 4, 5, 6.
**Turns green:** `closes a settled batch the inline path missed`, `runs the sweeps and the backstop while SOLICITATION_SEND_ENABLED is off`.

**Files:** Modify `src/lib/solicitation/release.ts`.

- [ ] **Step 1: Replace the Task 7 stub.** For every still-open batch the tick saw (approved, unhalted, unclosed), call `closeBatchIfSettled` in its own transaction. It returns `not_settled` cheaply when live rows remain. **No second implementation of the join** — one implementation, two callers, per D11.
- [ ] **Step 2: Confirm the flag scope.** Only the release phase reads `solicitationSendEnabled()`. The second test proves the sweeps and the backstop still run with the flag off.
- [ ] **Step 3: Run the whole release suite, then commit**

---

## Task 8 — The poller, registration and the env var

**Blocking edges:** Task 7.
**Turns green:** the `SolicitationReleasePoller.test.ts` loop-mechanics tests.

**Files:**
- Create: `worker/background/pollers/SolicitationReleasePoller.ts`
- Modify: `worker/index.ts`, `src/lib/config/worker.ts`, `.claude/reference/env-vars.md`, `docs/future-plans/2026-06-17-worker-scaling-hardening-backlog.md`

- [ ] **Step 1: Write the poller as a near-copy of `JudgeSweepPoller.ts`.** Same `createGuardedPoll` shape. `DEFAULT_INTERVAL_MS = 60_000`, `CYCLE_TIMEOUT_MS = 45_000` (below the interval, per `GuardedPollOptions`). Export `runSolicitationReleaseCycle(exec)`, `startSolicitationReleasePoller()`, `stopSolicitationReleasePoller()`.

  **No domain rules in this file.** It does NOT read the flag — decision 8 puts that inside the release phase. Its header comment states why.

- [ ] **Step 2: Add `SOLICITATION_RELEASE_POLL_INTERVAL_MS: rawOpt`** to `src/lib/config/worker.ts` beside `JUDGE_POLL_INTERVAL_MS`.

- [ ] **Step 3: Register in `worker/index.ts`.** Import beside `startJudgeSweepPoller`; add to the staggered boot array and to the shutdown path. Both, or the loop leaks on shutdown.

- [ ] **Step 4: Add the env-vars registry row.** Model it on the `JUDGE_POLL_INTERVAL_MS` row. State that the poller is NOT inert when `SOLICITATION_SEND_ENABLED` is off — only its release phase is.

- [ ] **Step 5: Add the P2 single-replica entry.** In `docs/future-plans/2026-06-17-worker-scaling-hardening-backlog.md`, add `SolicitationReleasePoller` with amendment B3's condition verbatim: *if the releaser is ever parallelized, the single-choke-point cap resolution must be revisited.*

- [ ] **Step 6: Run, then commit**

---

## Task 9 — Documentation sweep

**Blocking edges:** Task 8.

**Files:** `docs/directory.md`, `CONTEXT.md`.

- [ ] **Step 1: Add the `ci:directory-map` rows.** `src/lib/solicitation/release.ts` and `worker/background/pollers/SolicitationReleasePoller.ts` both need a row in the same PR or `ci:directory-map` fails. Follow the `send-caps.ts` row's shape: what it owns, then its traps.
- [ ] **Step 2: Update the `CONTEXT.md` **Halt latch** entry.** Strike "`send_window_elapsed` and `batch_expired` have no writer yet (#630)." Replace it with the writer: `latchSystemHalt`, the third arm, actor-less by 091's CHECK.
- [ ] **Step 3: Update the **Send breaker** entry.** It says "#900's releaser is a **pure reader**" in the future tense. Make it present.
- [ ] **Step 4: Run `pnpm ci:directory-map` and `pnpm test src/__tests__/claude-md-shape.test.ts`, then commit**

---

## Task 10 — Open the deferred follow-up issue

**Blocking edges:** Task 9.

- [ ] **Step 1: Open one issue** for amendment B14's gap: a halt-aware send window, or a distinct `platform_halt` cancellation reason so an owner is not told the send window elapsed for a cause that was a platform breaker trip. Cite B14 and note it needs a 091 CHECK widening.
- [ ] **Step 2: Note the residual yield-to-transactional obligation** in the same issue or a second one: `docs/superpowers/specs/2026-07-28-sender-deliverability-design.md` §7.1 asks for priority-yielding against the shared 10 req/s Resend team limit. #900 ships a per-tick release budget instead.

---

## Self-review against the spec

Left column cites the **executor design's decision numbers**, not the ticket's section
numbers (round-1 finding 12). Ticket #900's `§N` headings and the spec's `DN` decisions are
different numbering schemes, and mixing them made the original table unverifiable.

| Spec decision | Task |
|---|---|
| **D7** Shape B poller, no `poller_cursors` row, P2 backlog entry | 8 |
| **D7** release transaction, both guards | 1, 3 |
| **D9** veto window as a predicate, fail-closed on a NULL deadline | 3 (P4) |
| **§4.3 / B14** governors in the fixed order, all release-level | 3 |
| **D18** Judge split, both `judgeEnabled` and `isJudgeHealthy` | 3 |
| **D10** the two system Halt latch reasons | 2, 4, 5 |
| **D11** backstop join, one implementation two callers | 7 |
| **D12d** `unknown` terminalization, plus its child run | 6 |
| **D14** parent disposition rollup | **Already built.** `closeBatchIfSettled` writes the `send_batch_closed` step detail with `disposition` and all five counts. This feature adds no rollup code; it calls the function. |
| **B3** cap mechanism, counting basis, releaser-only enforcement | 3 |
| **B7** expired-unapproved batches close their parent | 5 |
| **B10** typed helper ships with its producer | 1 |
| **B14** `subscriptionGrantsFullAccess` at release level | 3 |
| **B14** the platform-halt gap | 10 (deferred, by owner decision) |

---

## Round 1 review appendix

**Reviewer:** codex, read-only sandbox. Thread `01a02a22-d338-7d92-9901-9c126aaa72af`.
**Verdict:** `REVISE`. Full report: `docs/reviews/feat-900-solicitation-release-poller/plan-round1-codex.md`.

Thirteen findings. **Twelve accepted and applied above; one rejected.**

The review's primary question — *can the eval pass while the feature is still wrong?* —
was answered **yes**, eleven times. Every accepted finding became a test title, not a prose
note. The intake's `tests_to_add` grew 27 → 38 and `estimated_test_lines` 1700 → 2300;
both are deviations-file entries, not `allowed_edit_surface` amendments, so neither counts
toward the abort budget.

**Rejected — finding 13 (MEDIUM):** *"the mandated `subagent-driven-development` sub-skill
is not installed."* It is present in the orchestrating session's skill catalog. Codex
inspects the repository, which does not carry Claude Code's skill registry, so the absence
it observed is an artifact of its own sandbox. No plan change.

Two findings changed the DESIGN, not just the tests:

1. **The Judge split moved to last** (finding 2). A downgrade is destructive; it must never
   fire for a batch the account cap alone would have stopped.
2. **The `unknown` sweep gained the child run** (finding 6), confirmed at
   `src/lib/solicitation/dispatch.ts:1752`. Terminalizing only the Outreach row re-opened
   the wedge from the spine side.
