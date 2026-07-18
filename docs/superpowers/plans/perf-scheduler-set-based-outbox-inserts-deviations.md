# Deviations — #484 set-based scheduler outbox inserts

## Task 2 (collapse 3 schedulers + allowlist + tests)

### Coverage split (weekly/monthly vs ranking behavioral test)

The plan's Task 2e asks for a behavioral integration test of scheduler OUTPUT.
Only `RankingTrackingScheduler` exports its cycle function (`runRankingCheck()`),
so the new live-DB test
`worker/background/schedulers/__tests__/RankingTrackingScheduler.integration.test.ts`
drives ranking directly (2 eligible businesses → one well-formed `track_ranking`
row each, distinct `correlation_id`s, second cycle enqueues 0 more).

`WeeklySummaryScheduler` / `MonthlyImpactScheduler` expose only `start*`/`stop*`
(no exported cycle fn). Rather than widen their interface purely for testability,
their behavioral coverage stays split across the existing suites, per the plan's
guidance to note the split instead of exporting internals:

- `summary-report-schedulers.test.ts` (mocked) — statement shape + gating:
  single merged `sql` call per cycle, `INSERT INTO job_outbox` +
  `ON CONFLICT DO NOTHING`, payload key names, two `gen_random_uuid()`, in-flight
  `NOT EXISTS`, `queued` = row count.
- `summary-schedulers-archived.integration.test.ts` (live DB, Task 1-era) — drives
  the real `start*Scheduler()` seam end-to-end and asserts the enqueued row +
  period-marker exclusion against Postgres.
- `migration-080-outbox-dedup.integration.test.ts` (live DB, Task 1) — owns the
  weekly index-semantics + preflight regression guards (in-flight-only predicate,
  completed-but-not-sent re-enqueueable, most-advanced-then-oldest preflight).

Net: ranking's collapsed output is proven directly; weekly/monthly output is
proven through the pre-existing live-DB archived suite + the 080 index/preflight
suite + the mocked shape pins. No scheduler interface was widened for tests.

### Migration-080 preflight test isolation (codex adversarial finding)

The preflight-regression scenarios in `migration-080-outbox-dedup.integration.test.ts`
seed TWO in-flight duplicates for one (aggregate_id, period). Against the REAL
job_outbox — already carrying 080's partial unique indexes — the second insert
hit 23505 and the CI `test` job went red (it only passed locally because the
suite self-skips without `TEST_DATABASE_POOL_URL`). Fix: each preflight scenario
now runs inside one `sql().begin()` transaction against a session-local
`CREATE TEMP TABLE job_outbox (LIKE public.job_outbox …) ON COMMIT DROP` (copies
no indexes, pg_temp shadows public → unqualified `job_outbox` resolves to it),
isolating it from the shared table and other test files. The index-SEMANTICS
scenarios stay against the real indexed table (they test the runtime guarantee).
Temp-table isolation was used — the beforeAll/afterAll drop-and-recreate fallback
was NOT needed.

### No new tenant-scope entries

The merged statement targets `job_outbox` in addition to the scanned tenant
tables, but `job_outbox` is not a tenant table, so `pnpm ci:tenant-scope` did NOT
flag it as a new cross-tenant surface. The three `*_CANDIDATES_SQL` constants
were repointed at the full merged statement text; the 8 `background-global-scan`
entries are unchanged and no entries were added.
