# Plan — fix/verification-remainders (rev 2, post-codex round 1)

Intake: `.feature/intake.json` (amended: cap 9, ADR surface, build gate).
Closes scalability-verification items 6 and 8 plus agreed hygiene. Four
tracer tickets; T2b depends on T2a, others independent.

## Design note (codebase-design pass)

No new seams. `worker/config/startup-assert.ts` is deepened with one more
assertion behind its existing interface; it owns the cap constants (single
authoritative owner). `worker/index.ts` stays pure registration. Migration
082 follows the 018 partial-index precedent with the 062 invalid-index
lesson applied.

Codex round-1 findings folded in: (1) `generate_demo` IS an LLM caller
(DemoGenerationWorker → demos/generator → responses/generator → runLlmTask)
— true non-gated slot sum is 9; user chose enforce-at-9 + ADR amendment.
(2) invalid-index recovery + `pg_index.indisvalid` test. (4a) honest
naming: worker-slot cap, single-replica scoped. (4b) `pnpm build` added to
gate. INCLUDE-column refinements deferred to staging EXPLAIN evidence.

## T1 — Migration 082: failover lookup indexes (+ log entry + integration test)

**File**: `supabase/migrations/082_failover_lookup_indexes.sql`

Header comment documents: CONCURRENTLY (live tables, non-zero-row
predicates), therefore apply OUTSIDE a transaction (SQL-editor
single-transaction mode off — 065 precedent), the two statements are NOT
atomic, and the **recovery procedure** for an interrupted build (062
lesson: `IF NOT EXISTS` silently skips an INVALID index): check
`pg_index.indisvalid` for each; if invalid, `DROP INDEX CONCURRENTLY
<name>;` then re-run.

```sql
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_jo_send_notification_by_aggregate
  ON job_outbox (aggregate_id, created_at DESC)
  WHERE topic = 'send_notification';

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_responses_pending_approval_created
  ON responses (created_at)
  WHERE status = 'pending_approval';
```

- Target queries: NotificationFailoverPoller.ts:118 (correlation lookup —
  exact mirror of 018's generate_response twin) and :160/:276 (global
  pending_approval sweeps; codex confirmed both are served, joins don't
  invalidate). No INCLUDE columns now — adopt only if staging
  `EXPLAIN (ANALYZE, BUFFERS)` shows material heap filtering (evidence rule).
- **Log**: append 082 entry to `.claude/reference/migrations-log.md`
  (head 081 → 082): both indexes, target queries, non-atomicity +
  recovery, staging-EXPLAIN evidence expectation.
- **Test**: `src/lib/shared/__tests__/migration-082-failover-indexes.integration.test.ts`
  (intake-surface-compliant path; 079's catalog-only harness is the
  precedent, 076's `pg_index` assertions the pattern). DB-gated, skips
  without `TEST_DATABASE_POOL_URL`. Asserts per index via `pg_index` +
  `pg_get_expr(indpred, indrelid)` + `pg_get_indexdef`: exists, partial
  predicate exact, `indisvalid` AND `indisready` true.

## T2a — Boot assert: `assertSummedLlmWorkerSlots`

**Module**: `worker/config/startup-assert.ts`, beside
`assertSingleConcurrencyWorker`.

```ts
export const SUMMED_LLM_WORKER_SLOT_CAP = 9;
export const FLAG_GATED_LLM_WORKER_SLOT_CAP = 1;

export function assertSummedLlmWorkerSlots(
  entries: ReadonlyArray<{
    queueName: string;
    opts: { concurrency?: number };
    flagGated?: boolean;
  }>,
): void;
```

Semantics (honest naming per codex 4a):
- This is a per-process **worker-slot budget**, the de-facto global LLM
  concurrency bound ONLY under single-replica deployment (ADR 0005); the
  doc comment says so, and notes per-job fan-out (demo `Promise.allSettled`
  over ≤15 reviews) is a **sanctioned unguarded lane** — bounded by the
  demo review-count cap and admin rate limits, NOT by cost guards and NOT
  by this assert (the cost-guard contract test documents the demo/eval
  exemption).
- Effective slots = `opts.concurrency ?? 1` (BullMQ default — five of the
  six LLM workers register with bare `workerOpts`; only generate_response
  is explicit).
- Non-flag-gated sum ≤ 9; each flag-gated entry ≤ 1.
- Error names offending queues, sum, cap, and the ADR rule (past ~10 →
  build the global Redis semaphore first).

**Call site**: `worker/index.ts` after LLM registrations, passing EFFECTIVE
`worker.opts` for: responseGenWorker(5), demoWorker(1), weeklySummaryWorker,
monthlyImpactWorker, onboardingDemoWorker, judgeVerdictWorker
(`flagGated: true`). The entries list carries a maintenance comment: "grep
runLlmTask callers before editing this list — generate_demo was missed once
(#490)." Trim the 215-219 comment to point at the assert as enforced owner.

**zernioBackfill comment**: extend the existing registration comment — the
`1` is a pacing cap, not a guarded single-consumer invariant; deliberately
NOT `assertSingleConcurrencyWorker`.

**Tests** (`worker/config/__tests__/startup-assertion.test.ts`, mirroring
the 873-888 block): sum exactly 9 passes (mixed explicit/undefined); sum 10
throws naming queues+sum+cap; undefined counts as 1; flag-gated 1 passes /
2 throws; drift (generate at 6 → sum 10) throws.

## T2b — ADR 0005 addendum amendment (depends on T2a naming)

Dated amendment note in `docs/adr/0005-beta-launch-posture.md` addendum
section: #490's queue inventory omitted `generate_demo` (a real
`runLlmTask` caller via the demo pipeline); the true non-gated worker-slot
sum is 9 and the enforced boot cap
(`assertSummedLlmWorkerSlots`, this branch) is 9. The ~10 semaphore
deferral trigger and all other posture is unchanged. Body of the original
addendum untouched.

## T3 — Hygiene

1. Dated correction banners atop
   `docs/reviews/feat-stripe-reconcile-remainders/spec-correctness.md` and
   `standards-maintainability.md`: migration renumber (079→081
   poller_cursors; 079/080 on main are agent-spine retention / scheduler
   dedup) and the `accounts(subscription_status, id)` index dropped
   pre-merge per EXPLAIN gate (`d93a62e8`) — see TRIAGE.md. Bodies
   untouched.
2. `.gitignore`: add `poller_cursors.cursor`.
3. Stray 0-byte `poller_cursors.cursor` at the PARENT checkout root: NOT
   touched during feature execution (worktree-only edit rule). It is
   surfaced to the user at ship as a one-line manual cleanup
   (`rm poller_cursors.cursor` in the parent checkout) — the `.gitignore`
   entry landing in this branch is the durable fix.

## Verification

`scripts/verify-gate.sh` (lint, typecheck, test, all ci:* audits,
db-touching set) + intake `verification_commands`: `pnpm build`. Ship lane
high-risk: staging ride, capture `EXPLAIN (ANALYZE, BUFFERS)` for the three
target queries on staging as PR evidence (INCLUDE-column decision point),
PR to main, pause for merge approval, apply 082 to prod at promotion.
