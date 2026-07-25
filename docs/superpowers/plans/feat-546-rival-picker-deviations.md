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

- **BLOCKER: `pnpm ci:tenant-scope` fails on the new module, and the fix lives
  outside Task 2's edit surface.** `predicateClauses` in
  `scripts/ci/tenant-scope-audit.ts` runs `stripSelectSubqueries` before matching
  `WHERE`/`ON` clauses, so every predicate inside a CTE body is invisible to it.
  The collapsed lane query is correctly scoped (`b.id = ${businessId}`,
  `rs.business_id = ${businessId}`, `cs.business_id = ${businessId}`), but the
  first two live inside `ctx`/`dates` and the scanner reports
  `businesses: missing … scope` and `ranking_snapshots: missing … scope`.
  `competitor_snapshots` passes because its predicate is in the outer `ON`.
  This is not fixable by restructuring: "latest two snapshot dates" needs a
  `LIMIT`, which needs a subquery. The sanctioned resolution is the same one
  already used for the identical scanner limitation elsewhere (see the
  `src/lib/kpi` entry: *"Scanner strips SELECT subqueries before predicate
  analysis"*) — two `tenant-root-lookup` entries in
  `scripts/ci/tenant-scope-allowlist.ts` plus `ALLOWLIST_BASELINE` 405 → 407.
  Left undone by Task 2 because that file is outside the task's permitted edit
  surface.

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
