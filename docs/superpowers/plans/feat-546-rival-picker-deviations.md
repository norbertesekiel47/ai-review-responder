# feat/546 rival picker — deviations

Short log of things the plan did not anticipate. One entry per surprise.

## Task 1 — migration 089

- **Migration-test drift-guard is a recurring landmine — promote to
  `.claude/reference/lab-notes.md` at step 8.** Whichever per-migration test holds
  the live "effective `event_name` CHECK list ⟺ `ANALYTICS_EVENT_NAMES`"
  assertion breaks the *next* time any analytics event is added, because the
  migration it guards is immutable and its list can never grow again. This has now
  happened twice and been fixed the same way both times: 058 handed the guard to
  069 (see the comment at `migration-058-offboarding-analytics-events.test.ts:40-42`),
  and this task hands it 069 → 089. The durable fix is to move the assertion out of
  per-migration tests into a single test that resolves the *latest*
  constraint-extending migration and asserts against that — out of scope for #546.

- **Plan's SQL header said "hence the lock_timeout above"; `SET lock_timeout`
  actually appears below the comment block.** Written as "below" in the shipped
  migration. Comment-only wording fix, no behavioral change.

- **069's test imported `ANALYTICS_EVENT_NAMES` solely for the assertion that was
  narrowed.** The import became unused (lint error) and was removed in the same
  edit. Not called out in the plan.

- **A naive "no DEFAULT" assertion on the whole migration file false-positives.**
  `[^,;]*` spans newlines, and the `COMMENT ON COLUMN` string literal contains the
  word "Auto-**default** rival". The nullability/no-default assertions in
  `migration-089-competitor-rival-pick.test.ts` are therefore scoped to the
  extracted `ALTER TABLE businesses …;` statement rather than the full file —
  which is also the more correct thing to assert.

## Task 2 — extract `named-rival.ts`

- **The single-CTE collapse trips `ci:tenant-scope`; resolving it cost surface
  amendment #2.** `predicateClauses` in `scripts/ci/tenant-scope-audit.ts` runs
  `stripSelectSubqueries` before matching `WHERE`/`ON` clauses, so every
  predicate inside a CTE body is invisible to it. The lane query is correctly
  scoped on all three legs (`b.id = ${businessId}`,
  `rs.business_id = ${businessId}`, `cs.business_id = ${businessId}`), but the
  first two live inside `ctx`/`dates`, so the scanner reported
  `businesses: missing … scope` and `ranking_snapshots: missing … scope`.
  `competitor_snapshots` passes because its predicate is in the outer `ON`.
  Not fixable by restructuring: "latest two snapshot dates" needs a `LIMIT`,
  which needs a subquery. Precedent: `src/lib/kpi/service.ts` carries seven
  `tenant-root-lookup` entries for this exact limitation, worded *"Scanner
  strips SELECT subqueries before predicate analysis"*. **Resolved** with two
  `tenant-root-lookup` entries sharing a hoisted `NAMED_RIVAL_LANE_SQL` const
  (the file's stated convention for a query the audit attributes to more than
  one table) plus `ALLOWLIST_BASELINE` 405 → 407 — which required adding
  `scripts/ci/tenant-scope-allowlist.ts` to the task's edit surface,
  **amendment #2**. Durable lesson: a CTE-shaped read in a `src/lib` domain
  module will always need an allowlist entry, so budget that file into the
  surface up front rather than discovering it at verification time.

- **The plan's "existing WeeklySummaryWorker competitor cases must pass
  unmodified" neutrality proof is unachievable as stated.** Those cases assert on
  the *three-statement* shape the same task orders collapsed into one — the mock
  `sql` queue feeds one result set per statement, and three assertions read
  `settingsQuery` / `datesQuery` / `packQuery` values separately. The proof was
  therefore re-based onto what the collapse does not change: every assertion on
  the *resolved* `competitorDelta` value and on rendered HTML stayed
  byte-identical (modulo the plan-blessed `line: {…}` nesting). Test plumbing
  changed as follows: `pushHappyPathSqlQueue` now composes the joined lane result
  set through a new `competitorLaneRows()` helper that models both `LEFT JOIN`s
  (empty-pack sentinel row per date, NULL `window_date` when no ranking
  snapshots), and the query-shape assertions became one lane query asserting
  `toHaveLength(1)`, the in-SQL `ctx` correlation predicates, and both
  `snapshot_date::text` casts. Coverage genuinely lost: keyword and
  search_location are no longer bound parameters, so their verbatim
  (untrimmed / lat-lng) round-trip can no longer be asserted from a mock — that
  correlation now lives inside the SQL and is asserted as query text.

- **`isPackJoinRow` narrows on `typeof row.snapshot_date === 'string'`, not
  `!== null`.** Postgres.js returns a selected-but-unmatched column as `null`, so
  `!== null` is right against the real DB — but it misclassifies the `undefined`
  a hand-built test fixture produces, and the resulting crash lands deep inside
  `parseCompetitorRating` with no clue. `typeof === 'string'` is also exactly what
  the guard's narrowed type claims.

- **The lane query selects `rival_place_id` / `rival_title_snapshot` (Task 3
  columns) as the plan specifies, which couples this commit to migration 089.**
  Nothing reads them until Task 3, but the SELECT is real: the branch cannot be
  deployed to an environment where 089 has not been applied. Not a Task 2 defect
  — just the ship-ordering constraint the plan's "089 is not applied anywhere
  yet" note does not spell out for this task.

## Task 3 — honor the pick

- **`escapeHtml` does NOT render `’` as `&rsquo;`.** `src/lib/shared/html.ts`
  escapes only `& < > " '`; the curly apostrophe passes through as a literal
  UTF-8 character. The plan's template assertions (`Joe&rsquo;s Bakery`) would
  have failed. Per the plan's own escape-check instruction, the new tests follow
  the file's existing competitor-delta convention instead: a straight-apostrophe
  fixture `"Joe's Bakery"` asserted as `Joe&#39;s Bakery`. The plan's
  `weeklyParams({…})` was likewise spelled `baseWeeklyParams({…})` (the factory
  this file actually has), and its `rivalDelta` helper gained a defaulted 4th
  `source` parameter rather than a duplicate factory.

- **`WorkerLogger` has no `.info` — the observability line uses `logger.log`.**
  `src/lib/shared/logger.ts` exposes `log` / `warn` / `error` only (`log` emits
  `level: 'info'`). The plan's `logger.info('competitor_delta_resolved', …)` does
  not compile.

- **No logger was in scope at the `resolveNamedRival` call site.** That call
  lives in `loadWeeklyValueInputs`, which took no logger. Per the plan's
  instruction, the handler's existing logger is threaded in as a parameter — no
  second logger is created. The nested-ternary source expression was extracted to
  a named `competitorDeltaSource()` so the log call reads as one fact.
  `WeeklySummaryWorker.test.ts` had no logger spy, so one was added as
  `vi.mock('…/logger', importOriginal => ({ ...original, createWorkerLogger: () => mockLogger }))`
  — spreading the original keeps `toError` / `logUnhandledPollError` real for
  every other module in that import graph.

- **`selectAutoDefaultRival`'s tail now delegates to `buildLineForRow`.** The
  plan introduced `buildLineForRow` for the pick path only, which would have left
  the gap/velocity arithmetic duplicated in two places that must never diverge.
  Behaviour is identical (the pre-existing Auto-default tests are untouched and
  still pass); `buildLineForRow` is now the single owner of that arithmetic.

- **Two tests added beyond the plan's list.** `escapes the dropped rival name in
  the dropout note` (the dropout note is a new `escapeHtml` call site and nothing
  else covered it), and `reports the owner-picked Named rival instead of the
  Auto-default one` in the worker suite — the plan's only new worker test asserts
  the log line, which would still pass if the pick never flowed from the `ctx`
  CTE into the rendered delta.
