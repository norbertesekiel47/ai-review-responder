# Plan review round 1 — #679 Import consent worker guard

## Executive result

Yes. T0 can pass while the feature is still wrong.

The blocking defect is a lost-import race between the proposed worker guard and
the existing acceptance transaction. The eval also drops a locked migration
test, does not prove the decision event uses the open transaction, does not pin
the guard's business-row predicate, and leaves an existing early-return path
ahead of the new guard. These are not stylistic concerns: each admits an
implementation that satisfies the listed T0 titles while violating the intake
or spec.

## Required revisions

1. **The planned guard can race an owner acceptance and permanently lose the
   import.**

   Concerned files: `worker/jobs/zernio/job-eligibility.ts`,
   `src/lib/reviews/import-consent.ts`, and
   `docs/superpowers/plans/2026-08-07-import-consent-worker-guard.md` T3.

   T3 specifies a standalone consent read followed by
   `markOutboxCompleted`. It does not put the read and completion in a
   transaction or lock the `businesses` row. The existing decision writer does
   lock that row (`src/lib/reviews/import-consent.ts:261-290`) and then calls
   `enqueueInitialImport`; that helper refuses to enqueue while any matching
   outbox row is `pending`, `dispatching`, or `dispatched`
   (`src/lib/reviews/import-consent.ts:455-472`). This interleaving is therefore
   possible:

   1. The worker reads `pending` from a hand-inserted dispatched row.
   2. The owner accepts. The acceptance transaction sees that dispatched row,
      so its `NOT EXISTS` predicate inserts no replacement.
   3. The worker completes the old row as a consent skip.

   The final state is `import_decision = 'accepted'`, no completed initial run,
   and no runnable initial-backfill row. That violates intake lines 18-19 and
   spec §5.1's accepted-but-incomplete retryability. All proposed state-by-state
   unit tests and worker ordering tests can pass because none races the guard
   against `recordImportDecisionAndEnqueue`.

   Missing failing test, target
   `worker/jobs/zernio/__tests__/job-eligibility.integration.test.ts`:

   > `an acceptance racing a pending-job consent skip leaves one runnable zernio_initial_backfill job`

   The test must force the interleaving above against Postgres and assert that
   either the current job proceeds or acceptance commits a replacement runnable
   row—never accepted consent with zero runnable rows. The plan should require
   serialization on the `businesses` row (for example, `SELECT ... FOR UPDATE`
   inside the same transaction as outbox completion, using the same
   business-before-outbox lock order as the acceptance writer).

2. **D1 removes a locked definition-of-done test and replaces it with
   one-directional shape checks that do not prove rejection.**

   Concerned files:
   `docs/superpowers/plans/feat-679-import-consent-worker-guard-intake.json:102-104`,
   `docs/superpowers/plans/2026-08-07-import-consent-worker-guard.md:219-226`, and
   `src/lib/shared/__tests__/migration-102-import-consent-analytics-events.integration.test.ts`.

   The intake explicitly requires `migration 102 still rejects an unregistered
   event name`. The plan says this is “not testable” by the 097 precedent and
   retitles it away. That conclusion does not follow. A rolled-back live insert
   can assert SQLSTATE `23514`; alternatively a strict predicate/list assertion
   can prove that the CHECK has no extra admitted branch. The proposed
   “strict-superset of 097” plus `ANALYTICS_EVENT_NAMES` subset guard permits
   extra DB-only names and does not prove rejection.

   Missing failing test, target
   `src/lib/shared/__tests__/migration-102-import-consent-analytics-events.integration.test.ts`:

   > `migration 102 rejects an event name absent from ANALYTICS_EVENT_NAMES`

   Restore this exact locked title instead of consuming a deviation to delete
   it.

3. **The eval does not prove `import_decision_recorded` is written through the
   open decision transaction.**

   Concerned files: `src/lib/reviews/import-consent.ts` and
   `src/lib/reviews/__tests__/import-consent.integration.test.ts`.

   `recordImportDecisionAndEnqueue` has both the outer `sql` client and the inner
   `tx` handle in scope. An implementation that calls
   `enqueueAnalyticsEvent(sql, ...)` from inside the callback can pass the
   proposed accepted, declined, rejected, and event-key tests on ordinary
   success, while allowing the analytics row to commit independently of a
   decision transaction that later rolls back. T2 says “inside `sql.begin`”,
   but none of its test titles asserts executor identity or transaction
   membership. This is exactly the transaction-boundary property that the
   `recordSuppression` precedent pins in
   `src/lib/solicitation/__tests__/suppression.integration.test.ts:365-406`.

   Missing failing test, target
   `src/lib/reviews/__tests__/import-consent-analytics.test.ts`:

   > `recordImportDecisionAndEnqueue passes the open transaction executor to import_decision_recorded`

   The assertion must distinguish `tx` from the outer `sql`; merely observing a
   committed event after a successful call is insufficient.

4. **The eval does not pin the target-business predicate in the fail-closed
   read.**

   Concerned files: `worker/jobs/zernio/job-eligibility.ts` and
   `worker/jobs/zernio/__tests__/job-eligibility.test.ts`.

   All nine proposed guard tests can be satisfied by queueing a returned
   `{ state }` row without proving that the executed SQL contains
   `WHERE b.id = <input businessId>`. A faulty unscoped query could read some
   other business's `accepted` state and let a pending target import. The plan
   promises the binding in §2, but T0 is the enforcement spot check and has no
   title for it.

   Missing failing test, target
   `worker/jobs/zernio/__tests__/job-eligibility.test.ts`:

   > `guardImportConsent scopes the derived-state SELECT to b.id = businessId`

   Assert both the flattened SQL text and the bound `businessId` value via
   `sqlCalls`.

5. **The implementation point leaves the unsupported-tier path ahead of the
   consent guard.**

   Concerned file:
   `worker/jobs/zernio/__tests__/ZernioBackfillWorker.test.ts` and plan T4.

   The current handler rejects an unsupported tier before
   `extractOutboxHandle` (`ZernioBackfillWorker.ts:125-138`), and the existing
   test at lines 259-273 explicitly requires no SQL and no outbox completion.
   T4 says to add the guard immediately after `extractOutboxHandle`, which—as
   written—preserves that bypass. Thus a non-accepted hand-insert with a stale
   or malformed tier reaches `handleZernioBackfill` but fails/retries before the
   fail-closed consent skip. That contradicts the intake's unqualified promise
   that a non-accepted backfill job completes as a skip.

   Missing failing test, target
   `worker/jobs/zernio/__tests__/ZernioBackfillWorker.test.ts`:

   > `non-accepted consent no-op-completes before unsupported-tier validation`

   If malformed payloads are intentionally exempt, the intake and T4 must state
   that carve-out explicitly and the existing test must remain the authority;
   the present plan does neither.

6. **The fixture update is correctly counted but is not the whole existing-test
   migration.**

   Concerned file:
   `worker/jobs/zernio/__tests__/ZernioBackfillWorker.test.ts`.

   The suite does contain 35 tests and 30 `pushImportSqlSetup` call sites. The
   helper queues the four claimed results in the claimed order. However, three
   handler tests manually queue SQL outside that helper: archived-location
   (lines 307-334), missing-business (339-355), and already-completed
   (965-978). All need a consent result prepended once the guard moves before
   the run INSERT. More importantly, the missing-business backfill test's
   expected `subscription_status=missing` eligibility log becomes unreachable:
   the new consent guard must intercept the missing row first and emit the
   consent-block log. T0/T4 does not identify this required retitle/rewrite.

   This is a plan sequencing/test-maintenance defect rather than a new coverage
   title: enumerate these three tests in T0/T4, and rewrite the missing-business
   assertion to the new authoritative guard behavior.

## Cited-artifact audit

### Confirmed

- `importConsentStateSql` exists at
  `src/lib/reviews/import-consent.ts:117-125`, takes `SqlExecutor`, hardcodes the
  `b` alias, uses Postgres `now()`, and derives the inclusive `<=` expiry.
- `createImportOffer` exists at lines 186-221 with the assumed
  `(TransactionSql, businessId, accountId) -> 'created' | 'unchanged'` shape.
- `recordImportDecisionAndEnqueue` exists at lines 255-305 with the assumed
  `(Sql, businessId, accountId, accepted|declined) -> ImportDecisionOutcome`
  shape and owns `sql.begin`.
- `enqueueInitialImport` exists at lines 380-474 with the assumed
  `(TransactionSql, businessId, accountId) -> void` shape.
- `guardZernioJobEligibility` exists at
  `worker/jobs/zernio/job-eligibility.ts:51-100`; the cited tenant-key query is
  exactly at lines 60-65, and its return is the stated proceed/skipped union.
- `pushImportSqlSetup` exists at
  `worker/jobs/zernio/__tests__/ZernioBackfillWorker.test.ts:170-185`. It queues
  run INSERT, run SELECT, eligibility row, then connection row. There are 30
  call sites (excluding the definition) across 35 existing tests.
- `src/lib/locations/archive-location-tx.ts:539-545` reads consent and requires
  `reactivationConsent?.state === 'accepted'` before the reactivation enqueue.
- Migration head is 101 in both the migration directory and
  `.claude/reference/migrations-log.md:4`; no 102 migration exists, so 102 is
  free.
- The drift-guard handoff is real: 089 now pins its historical 19-name list,
  094 pins its historical 21-name list, and 097 owns the current
  `ANALYTICS_EVENT_NAMES` subset guard. Migration 097 contains 23 names in 094
  order plus its two additions.
- `src/lib/shared/worker-types.ts:225-227` contains the stale two-producer JSDoc
  the plan identifies.
- Admin runbook scenario A5 exists at
  `src/app/admin/runbook/page.tsx:95-105` and currently gives the unconditional
  re-enqueue instruction described by the plan.

### Misses and overclaims

1. **`docs/adr/0015-consented-import-unflagged-replacement.md` has no “R2”.**
   Plan line 6 cites “ADR 0015 (R2 — this ticket closes it)”, but the ADR has
   numbered prose sections only. The literal R2 is in the design spec §8a and
   concerns ticket ordering (#677 before/with #676), not this worker hole. Cite
   ADR §2 for the sequencing decision and spec §5.3 for the worker chokepoint;
   do not cite a nonexistent ADR subsection.

2. **The cited design section is stale on producer count.** Spec §5 lines
   143-150 and §5.3 lines 207-209 still say three enqueue paths/gates, while the
   real source has three `enqueueInitialImport` callers plus the separate
   accepted-only reactivation enqueue. The plan's “four” is correct against
   source, but it is not content supplied by the cited §5 text. The design of
   record should be corrected or the plan should explicitly identify this
   source-verified drift.

3. **The `zernio_backfill_runs` INSERT is not literally at line 148.** Line 148
   is the `if (isReactivationBackfill)` branch; the two INSERT statements start
   at lines 150 and 163. The intended placement is still unambiguous, but the
   exact line citation is inaccurate.

4. **`ci:analytics-events` does not parse or validate the full block the plan
   lists.** `scripts/ci/analytics-events-audit.ts:13-22` reads only a
   `### \`event_name\`` heading and an optional `**Status:**` line. Description,
   Owner, Source, Distinct ID, Event key, Required properties, Optional
   properties, and Privacy notes are ignored. The proposed entries will be
   recognized, but CI does not enforce the claimed full format. If those fields
   are definition-of-done, add a failing parser/audit test in
   `scripts/ci/__tests__/analytics-events-audit.test.ts` titled:

   > `live analytics event blocks require every taxonomy field`

5. **The intake's 097-suite precedent is factually wrong.** Intake line 56 says
   the 097 suite “must hold `acquireLiveDbLock` and roll back any unconditional
   re-apply”. The actual
   `migration-097-suppression-analytics-events.integration.test.ts` is a pure
   SQL-text suite, explicitly says no live DB is needed, and contains neither.
   The plan's later description of it as text-only is the accurate one; correct
   the locked intake's precedent instead of carrying both claims.

## Plan-level conclusions

- Moving the consent guard before the run-row INSERT is well pinned by the
  proposed ordering/no-row/no-`completed_at` tests. The gap is not that
  placement; it is the missing serialization with acceptance.
- The separate guard preserves live-ingest structural independence, and the
  graph shows `handleZernioBackfill` has one production caller
  (`worker/index.ts`), so there is no second production dispatch path around the
  proposed call site.
- Migration 102 must still precede emitting code, as the plan states. That
  sequencing hazard is accurately supported by the DB CHECK and by migration
  097's precedent.
- The plan must restore the locked rejection test rather than treating T0's
  definition of done as retitling material.

VERDICT: REVISE

---

## Orchestrator triage — 2026-08-07

Each finding independently verified against source before triage; the plan was
revised in the same pass. Plan revision committed alongside this file.

| # | Finding | Verdict | Where addressed |
|---|---|---|---|
| 1 | Lost-import race with the acceptance transaction | **ACCEPT** | Plan §2 + T3 — guard now runs in `sql.begin` with `FOR UPDATE` and in-transaction `markOutboxCompleted`; deviation D3; race test added to `tests_to_add` |
| 2 | D1 deleted a locked rejection test | **ACCEPT** | Locked title restored verbatim; implemented as a live SQLSTATE `23514` assertion. D1 rewritten — it was an expansion, never a deletion |
| 3 | Decision event not proven to ride the open tx | **ACCEPT** | T2 — pinned behaviourally (force rollback, assert no surviving row) per the `suppression.integration.test.ts:365-406` precedent |
| 4 | Guard's `b.id` predicate unpinned | **ACCEPT** | T3 — assert flattened SQL text *and* the bound value via `sqlCalls` |
| 5 | Unsupported-tier path precedes the guard | **ACCEPT requirement / REJECT reorder** | T4 — carve-out stated explicitly in intake `edge_cases` + T4, pinned by a new test. Reorder rejected: a malformed tier is an assert-impossible-state throw, no import occurs either way, and only the outbox disposition differs. Trading a loud bug signal for a silent skip is the wrong direction |
| 6 | Three hand-queuing tests + unreachable missing-business log | **ACCEPT** | T0 — the three tests enumerated in a table; missing-business rewritten to the new authority; both guard-ordering JSDoc blocks to be corrected |
| M1 | ADR 0015 has no "R2" | **ACCEPT** | Verified: ADR has §1–4; R2 is spec §8a:301. Plan header corrected; `.claude/CLAUDE.md` carries the same error → post-merge sweep |
| M2 | Spec §5 stale on producer count (3 vs 4) | **ACCEPT** | Deviation D8 — noted as source-verified drift; spec is outside `allowed_edit_surface`, correction rides the post-merge sweep |
| M3 | `zernio_backfill_runs` INSERT not at line 148 | **ACCEPT** | T4 — corrected to "after `extractOutboxHandle` (138), before the INSERTs at 150/163" |
| M4 | `ci:analytics-events` parses only heading + Status | **ACCEPT correction / REJECT new parser test** | T1 — overclaim corrected. Proposed `live analytics event blocks require every taxonomy field` audit test rejected as scope creep: the taxonomy is a doc convention, not this ticket's definition of done |
| M5 | Intake wrongly credits the 097 suite with `acquireLiveDbLock` | **ACCEPT** | Intake `existing_patterns_to_follow` corrected — 097 is pure SQL-text; 102's suite adds live assertions and must not re-apply migration SQL |

**Net:** 11 findings, 9 accepted in full, 2 accepted with a sub-proposal rejected
and the reasoning recorded. `tests_to_add` 28 → 38. No `allowed_edit_surface`
amendment; abort budget stays 0 of 2.

Round 2 is **verification-only** per the round protocol: the reviewer sees this
table plus the revision diff, confirms each fix landed, and may flag defects a fix
introduced — it may not open new fronts against unchanged plan sections.
