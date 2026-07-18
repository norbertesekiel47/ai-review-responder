# Deviations — #479 Stripe reconcile remainders

Small, in-scope departures from the plan, recorded per the T1 instructions.

## T1

- **`reconcile-progress.ts` created in T1 with only `nextCursor`.** The plan lists
  `reconcile-progress.ts` under "New modules" with three fns and re-lists it in
  T3's step 1 (`classifyCycle`, `evaluateTruncation`). T1 needs `nextCursor` as an
  exported fast-check surface (T1 test list), so the file is created now holding
  ONLY `nextCursor`; T3 extends it with the classification fns + the
  `{queryCompleted,total,dispatched}` progress snapshot. No progress-snapshot
  plumbing was added to the poller in T1 (not needed for the cursor persist), so
  `reconcileCycle`'s signature is unchanged (`(signal)`), leaving the `progress`
  param for T3.

- **Extra constant `CURSOR_LOAD_TIMEOUT_MS` (10_000) added to `constants.ts`.** The
  plan enumerated `POLLER_NAME` + `CURSOR_SAVE_TIMEOUT_MS` only, but plan step 3
  requires the boot load be "bounded by its own withTimeout". That bound needs a
  value; added alongside the save timeout. Its purpose is to free a parked
  connection in the ~45s window between `start()` and the first tick, where
  nothing else awaits the load.

- **Never-settling-boot-load test asserts recovery, bounded by whichever timeout
  fires first.** The plan's test wording says "bounded by the cycle deadline". In
  the implementation the boot load has BOTH its own 10s `withTimeout` AND the
  240s cycle deadline (reconcileCycle awaits `cursorLoaded` inside runOnce's
  `withTimeout`); the earlier 10s bound wins in the never-settling case. The test
  advances past every bound (240s+) and asserts the essential guarantee —
  `inProgress` is released and the next tick runs — so it is agnostic to which
  bound fires. Both bounds exist; defense-in-depth.

- **`PollerCursor` type defined locally in `cursor-store.ts`** (its `loadCursor`
  return type) rather than added to `billing-reconciliation/types.ts`, to keep the
  edit surface tight and colocate the type with its sole owner.

- **`ci:tenant-scope` did NOT trip on `poller_cursors`** (it holds no `account_id`
  and is not a tenant table), so no `scripts/ci/` allowlist entry was needed. The
  plan flagged this as conditional ("if it trips").

## T3

- **`stalled` (queryCompleted === false) leaves the counter untouched — reconciling
  the plan's `classifyCycle` with the intake edge_case.** The intake's edge_cases
  note says "an abort with dispatched === 0 (fully stalled, e.g. parked on pool
  acquisition then deadline) DOES count as a truncation." The plan's Rev 5
  `classifyCycle` refines this: the distinguishing fact is whether the accounts
  query COMPLETED. `!queryCompleted` (the query itself never returned — pool
  starvation / query timeout) → **stalled**, counter untouched (DB-availability is
  the HealthAlertPoller's concern, not a truncation-of-work signal). A completed
  query that then aborts with `dispatched === 0` (a fetched batch left entirely
  unclaimed) IS `dispatched < total` → **truncated**, counting toward the alert —
  exactly the intake's intent. Implemented per the plan/task classifyCycle table;
  `classifyCycle({queryCompleted:true, total:10, dispatched:0}) === 'truncated'` is
  asserted directly.

- **`ReconcileProgress` type lives in `reconcile-progress.ts`** (exported alongside
  `classifyCycle`/`evaluateTruncation`), colocated with the pure fns that consume
  it; the poller imports it `type`-only. No new file for a one-field-shape type.

- **`reconcileCycle`'s new `progress` param has a default value.** Signature became
  `(signal, progress = {queryCompleted:false,total:0,dispatched:0})` so the many
  existing tests that call `reconcileCycle(signal)` directly (abort-loop, keyset
  cursor, boot-load) compile and run unchanged; only `runOnce` passes a real
  snapshot it later classifies.

- **Unit test (a) exercises a full-dispatch drain via per-account timeouts, not a
  literal cycle-level TimeoutError.** A cycle-level `TimeoutError` with
  `dispatched === total` is not cleanly reachable given `ACCOUNT_TIMEOUT_MS (60s) <
  CYCLE_TIMEOUT_MS (240s)`: once every account is claimed, each per-account
  `withTimeout` settles at ≤60s, so the cycle always RETURNS before its own 240s
  deadline. The test therefore drives 3 (= fan-out concurrency) parked accounts —
  all claimed in one wave (`dispatched === total`), all hitting the 60s per-account
  timeout, the cycle then returning normally → classified `drained`, no alert. This
  covers the same classification branch the plan's (a) targets (full dispatch ⇒ not
  truncated ⇒ no false alert).

- **Truncation is driven in tests by parking `mockStripeRetrieve` forever across
  100 accounts.** `reconcileAccount` reaches the Stripe retrieve before any DB read
  for accounts with a `stripe_subscription_id`, so a parked retrieve deterministically
  starves the sweep: at the 240s cycle deadline only ~12 of 100 are claimed
  (`dispatched << total`) → `truncated`, independent of exact per-wave timing. The
  detached cycle fully unwinds within the same fake-timer advance (workers exit on
  the abort), leaving no cross-cycle orphans that could touch the counter/alert
  (both are mutated only in `runOnce.finally`, synchronously, per run).

- **`emitTruncationAlert` is best-effort via the call-site guard**, mirroring
  `drift-alert.ts` (which has no internal try/catch). `runOnce.finally` wraps the
  whole classify→evaluate→emit block in a `try/catch` (log-and-swallow) that runs
  BEFORE the cursor persist, so an emitter failure can never throw out of finally,
  block the persist, or wedge `inProgress` (invariant #3 / T1 contract preserved).

## Adversarial-review fixes (post-plan, #479 remainders)

- **FIX 1a — boot-load failure no longer poisons the write-seq CAS.** A failed
  cursor boot-load left `writeSeq=0` while the store could hold `write_seq=N`, so
  saves were CAS-rejected for N cycles (persistence silently disabled). Added a
  `writeSeqSeeded` flag; `runOnce.finally` re-seeds `writeSeq` (+`accountCursor`)
  from a fresh `loadCursor` before its first save, and SKIPS the persist if the
  re-seed also fails (in-memory cursor still advances; restart re-walks safely).
  Proven by the seq-6-after-a-rejected-boot-load test + a skip-on-double-failure test.

- **FIX 2a — a non-timeout cycle error is no longer mis-scored as a truncation.**
  Threaded a `CycleOutcome ('ok'|'timeout'|'error')` into `classifyCycle`: `ok`→
  drained, `error`→stalled, `timeout`→existing snapshot logic. A post-query throw
  (e.g. `getStripe()` failing) is now `stalled`, not `truncated`. Proven by a runOnce
  test forcing `getStripe()` to throw across 3 cycles → zero sustained-truncation alerts.

- **FIX 2b — "consecutive" truncations are now literal.** `evaluateTruncation`
  resets the counter to 0 on ANYTHING that is not `truncated` (both `drained` and
  `stalled`), so T,S,T,S,T no longer pages as three consecutive. Proven by the
  updated fast-check property test + a T,S,T,S,T streak-break test + the updated
  poller stall test (a stall now resets, so a fresh run of 3 is needed to alert).

- **FIX 3 — cursor boot-load deferred past the boot storm.** `start()` no longer
  kicks `beginCursorLoad()`; `runOnce` lazily kicks it on the first tick
  (`if (cursorLoaded === null)`), so the SELECT lands at +INITIAL_RUN_DELAY_MS
  (post-storm). Proven by the updated defer test (start() queries nothing at boot;
  the first tick issues both the cursor-load and the accounts query).

- **Test-harness seam `simulateBootLoadedForTests()`.** FIX 3's lazy load and FIX
  1a's re-seed each issue an extra `loadCursor` SELECT; the many `runOnce`-driving
  tests use a mock-`sql` FIFO queue that would mis-account those. `beforeEach` now
  simulates a completed successful boot-load (no SELECT) so bulk tests keep their
  pre-persistence FIFO accounting; boot-load-specific tests reset back to null.

## Step 8 — T2 composite index DROPPED at the ride-time EXPLAIN gate

- **Migration 082 (`idx_accounts_reconcile_status_id` on `accounts
  (subscription_status, id)`) was built, applied to staging, then dropped with user
  sign-off.** T2's plan step 3 mandated a staging `EXPLAIN (ANALYZE, BUFFERS)` and
  said explicitly: "if not [used] at current scale → keep as documented
  future-proofing or drop — decide with evidence." The evidence:
  - **Default plan (both cursor forms):** Seq Scan on `accounts` (staging table
    empty — 0 rows).
  - **Forced `enable_seqscan = off` (both cursor-null and cursor-set):** planner
    chose **`accounts_pkey`** (the existing PK on `id`), NOT the composite index —
    `Index Cond: (id > cursor)` with `subscription_status` as an inline filter.
  - **Selectivity check:** both prod (`udeyaqnvpojbwgoaxwdg`) and staging
    (`kubdiqdhqbhwmqfditeg`) have **0 accounts** — RepWorth is pre-launch, so the
    status filter's selectivity cannot be measured and the index has no data to help.
  - **Structural reason:** the reconcile query is a bulk keyset scan
    (`status IN (billable) AND id > cursor ORDER BY id`, no LIMIT). The PK serves the
    `id > cursor` range + `ORDER BY id` directly; leading with the low-selectivity
    `subscription_status` only pays off with a large non-billable (churned) tail,
    which does not exist at the beta/100-business capacity target (ADR 0006: a full
    rotation drains in one cycle).
  - **Decision:** DROP. Keeping an index the planner won't pick is pure write
    overhead + space on the billing-critical `accounts` table. It is a one-line
    CONCURRENTLY migration, re-addable in seconds if a future prod EXPLAIN (with real,
    churn-heavy data) ever shows it wins. Aligns with the repo's "no infra before
    proven need" rule. T1 (cursor persistence) and T3 (truncation alert) still ship.
  - **Applied removal:** index DROPped on the staging DB (CONCURRENTLY); migration
    082 file + all references (migrations-log, intake goal + surface, plan T2,
    handoff) removed on the feat branch and the staging branch. Intake goal amended
    with user sign-off (scope reduction: two deliverables, not three).
