# F1 Owner-Unreachable Escalation — Deviations Log

Deviations from the rev-4 plan surfaced during subagent execution. Each is a
non-structural adaptation to match the real codebase; none change the locked
intake contract. Recorded for the step-7 reviewers and any resumed session.

## T1 (marker foundation) — none

Head was 082 as predicted; `warnOutboxNoop` uses `console.warn` (test warn-spy
unchanged); `SqlExecutor`, `dispatchedRow(exec, outboxId, attempt)` arity, and
`res.count` all matched the plan's illustrative code verbatim. Commit `a469e8bc`.

## T2 (NotificationWorker) — trivial only

`mock.calls[0]` needed a `!` non-null assertion for `tsc` (TS2488). Branch
structure, discriminator (`eligibility.reason === 'no_verified_enrollments'`),
and local var names (`sql`/`outboxId`/`outboxAttempt`/`logger`/`businessId`) all
matched the plan. Commit `f17330dd`.

## T3 (health check) — integration-test robustness adaptation

The `checkOwnerUnreachable` / `checkZeroDeliveryNotifications` queries are global
`COUNT(*)` (not tenant-scoped), so the real-PG integration test asserts on the
**delta** (baseline before/after each seed) rather than absolute counts — robust
against pre-existing rows in a shared CI DB. To read the raw count including 0,
the integration probe config uses `ownerUnreachableThreshold: -1` so the check
always returns a finding; the threshold **gate** itself (return null at/below
threshold) is covered by the mock-sql suite. Commit `5cbfa115`.

## T4 (failover poller arm) — two flags worth reviewer attention

1. **Integration case (b) wording vs. R3-B — reconciled, not a defect.** The plan
   listed integration negative case (b) as "an in-flight `send_notification`
   exists → no new row, **no email**". Taken literally with a *completed*
   `owner_unreachable` marker also present, that contradicts **R3-B** (email is
   gated on `unreachable`, which stays true while a retry is in-flight). The
   reconciliation: the candidate SELECT keys off the **latest COMPLETED**
   send_notification reason, so a draft whose only send_notification is in-flight
   (never completed) has a NULL subquery result → it is **never selected** → no
   email. That is the scenario case (b) actually encodes (in-flight-only, no
   completed marker). The genuine in-flight **retry-gate** (completed marker +
   a newer in-flight retry) is exercised by the **twice-run case (c)**: run 1
   INSERTs the retry + sends the email; run 2 sees `in_flight=true` → **no second
   INSERT** (at-most-once) and the email is **24h-deduped** by `tryClaimAlert`.
   Net behavior matches R3-B and the intake "Retry idempotency" invariant.
   Encoded in a test comment at the case-(b) seed.

   **UPDATE (step-6 adversarial review, commit `96fe61cd`):** this reconciliation
   is now moot — Finding 2's fix added an in-flight exclusion to the candidate
   SELECT, so an owner-unreachable draft with an in-flight retry is excluded at
   the candidate level. Case (b) was rewritten to seed a completed
   `owner_unreachable` marker PLUS a newer in-flight `dispatched` row and assert
   candidate-level exclusion (no retry, no email). R3-B's "email while in-flight"
   is partially reverted (see ADR 0010 post-implementation section); the locked
   re-check `in_flight` path now models the concurrency race, not steady state.

2. **Local test-DB bootstrap for migration 083.** The local test DB (:5499)
   predated migration 083, so the T4 integration `beforeAll` applies an
   idempotent `ALTER TABLE job_outbox ADD COLUMN IF NOT EXISTS completion_reason
   TEXT` as test-DB bootstrap. Migration 083 remains the authoritative schema
   source; this is a no-op against a fully migrated CI DB (CI provisions
   `TEST_DATABASE_POOL_URL` and applies migrations). It is a direct column-add
   rather than replaying `083_*.sql` because that file's `BEGIN/COMMIT` can't run
   via `sql.unsafe` on the multi-connection Postgres.js singleton.

3. **`tx.json(payload as never)` on the retry INSERT** — mirrors the established
   JSONB-encoding pattern the existing all-failed/stale arms use inside
   `sql.begin`; not a new cast style introduced by this feature.

   Commit `36e14b72`.
