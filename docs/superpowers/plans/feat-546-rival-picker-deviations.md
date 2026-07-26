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

## Task 4 — picker view + write route + analytics

- **A lock-blocked interleaving CANNOT observe a concurrent pack replacement —
  measured, not assumed.** The plan's two concurrency tests were sketched as
  "block the write on a row lock, let the worker commit a new pack, release".
  A throwaway two-connection probe against the test DB says that construction
  can never fail a correct implementation: under READ COMMITTED, when
  `UPDATE b … FROM cs` blocks on the `businesses` row lock and the blocker
  commits, EvalPlanQual re-checks the *target* tuple but keeps the statement's
  original snapshot for the joined `competitor_snapshots`. All four probe
  variants (same-date / new-date × blocker-touches-target / not) resumed and
  stored the removed rival. So both concurrency tests are written as the real
  request-level race instead — `loadRivalPickerView` renders the option, a
  **second connection** commits the pack change, then the submit lands — which
  is deterministic and is what the owner actually experiences. Mutation-tested:
  replacing the `MAX(snapshot_date)` subquery with `IS NOT NULL` fails *only*
  the new-date test, so that test is a genuine discriminator for the
  pre-resolved-date hole the adversarial review found.

- **Zero rows from the write is ambiguous, and the plan's `RivalPickStaleError`
  alone would have leaked a foreign location as a 409.** `UPDATE … WHERE b.id =
  … AND b.account_id = …` returns zero rows both for "not a pickable rival" and
  for "not your location", and the clear's zero-row case adds a third meaning
  ("already cleared"). Both writers therefore call a shared `assertLocationOwned`
  on the failure path only — after the write has already been declined, so no
  race is reopened — which is what makes the plan's own "404 for a businessId
  outside the caller's account" module test achievable. Without it a foreign
  *clear* would have returned 200.

- **`rival_picked_at = CASE … END` gained an `OR b.rival_picked_at IS NULL`
  leg.** The plan's `IS DISTINCT FROM` guard alone lets `RETURNING
  rival_picked_at` come back NULL for a row where `rival_place_id` is already
  set but the timestamp is not (only reachable by a hand-edited row), and
  `.toISOString()` on it would throw while building the event key. The extra leg
  keeps `RETURNING` non-null without weakening retry idempotency.

- **Backticks inside a SQL template literal terminate the string.** The plan's
  comment "derived from `b` INSIDE the statement" pasted verbatim into the
  tagged template produced a parse error, not a comment. Reworded without
  backticks.

- **The test DB was two migrations behind, not one.** 089 was expected; the
  shared local DB was also pre-085, so `competitor_snapshots.rating` was still
  `REAL`. Postgres.js hands `REAL` back as a JS number, and
  `parseCompetitorRating(rating: string | null)` calls `.trim()` on it — the
  suite would have crashed on a type that cannot occur in staging/prod. Both
  migrations were applied to the test DB, and the suite carries a guarded,
  advisory-locked `applyRivalPickMigrationsIfMissing` (074-helper convention) so
  it is self-sufficient on a fresh DB.

- **`src/lib/analytics/__tests__/events.test.ts` pins the allowlist array
  exactly.** Registering the event broke it; the expected array and the
  not-client-postable list were both extended. The plan did not mention this
  file (only `ci:analytics-events` and the 089 migration test).

- **`loadRivalPickerView` uses three flat statements, not one CTE.** Deliberate:
  the Task 2 collapse needed `tenant-root-lookup` allowlist entries precisely
  because the audit strips SELECT subqueries, and `scripts/ci/tenant-scope-allowlist.ts`
  is outside this task's edit surface. Three flat, individually-scoped reads
  pass `ci:tenant-scope` unchanged (407 entries, baseline 407). The consistency
  argument the digest needs does not apply to a read-only view whose worst
  outcome is rendering a pack replaced a moment ago — and the write re-validates
  membership against committed state regardless.

- **GET validates `businessId` as a UUID before the branded cast.** Not in the
  plan, which specified strict Zod for the PUT body only. Without it a malformed
  search param reaches a `uuid` column and turns a 400-shaped request into a 500
  plus Sentry noise.

- **Full-suite `pnpm test` is flaky against the shared local test DB, and it is
  not this task's doing.** Several suites (`account-offboarding/integration-lifecycle`,
  `solicitation/batch-builder.integration`) parse `.env.local` in their own
  `vi.hoisted()` block, so they run live even when `TEST_DATABASE_POOL_URL` is
  unset in the environment, and they deadlock against parallel siblings.
  Excluding ONE unrelated file (`migration-089-…test.ts`) moves the failure to a
  different suite, which is the signature of scheduling perturbation rather than
  a semantic conflict. Verified green: every audit, `typecheck`, `lint`, and the
  three suites this task owns.

## Task 5 — settings page

- **No CSS was added; the inline notice reuses `.auto-policy-warning`.** Every
  settings class the page needs already exists, but they live in
  `src/app/(authenticated)/_styles/settings.css`, which is outside this task's
  edit surface (only `globals.css` was allowed). Putting a settings-scoped
  class in `globals.css` would split the settings stylesheet across two files
  for one message box, so the existing warning box is reused as-is.

- **Location names are shown whenever there is more than one view, not only
  when `multiLocation` is true.** `shouldUseMultiLocationSettings` also requires
  `MULTI_LOCATION_ENABLED`, so an account with several active locations and the
  flag off would have rendered several indistinguishable pickers. The prop
  contract is unchanged; the component ORs it with `views.length > 1`.

- **The select is labelled with `<label htmlFor>` rather than the auto-approval
  client's visible-span-plus-duplicated-`aria-label` pattern.** Same accessible
  name (`Named rival for '<keyword>'`), one source of truth, and it keeps the
  format hint out of the computed name.

- **Two tests beyond the five promised titles.** The 409 `pack_refreshed` path
  (inline message + GET reload) and the multi-location labelled blocks are both
  behavior the plan specifies but did not name a test for; neither is reachable
  from the five fixtures.

- **`SettingsSidebar.test.tsx`'s "renders both group labels and all items"
  enumerates every nav item.** Adding Competitors without extending that array
  would have left the test claiming completeness while checking 7 of 8 items.

---

## Step 6.5 — deviations triage (orchestrator, pre-review)

Every entry above read end to end and given a verdict. ACCEPT = the adaptation
is sound and stands. RE-PLAN = it invalidates a locked intake decision (abort
criteria). **No entry was verdicted RE-PLAN.**

**Task 1 — all ACCEPT.** The drift-guard handoff (069 → 089) follows the
precedent 058 → 069 already set; the two test-authoring corrections
(whole-file `DEFAULT` false-positive, orphaned import) are the agent fixing its
own work. The migration-test landmine is the single highest-value lesson on this
branch and is tagged for lab-notes promotion at step 8.

**Task 2 — all ACCEPT, one with a noted cost.** The "existing competitor cases
pass unmodified" neutrality proof was unachievable *as written* — those cases
assert the three-statement shape the same task ordered collapsed, so the plan
contradicted itself. Re-basing the proof onto resolved `competitorDelta` values
and byte-identical rendered HTML preserves what the proof was *for*. Genuine
coverage loss recorded and accepted: keyword/search_location are no longer bound
params, so their round-trip is asserted as query text rather than values. The
tenant-scope allowlist entries cost surface amendment #2 (owner-approved).

**Task 3 — all ACCEPT.** Three plan snippets did not compile or pass as written
(`escapeHtml` does not emit `&rsquo;`; `WorkerLogger` has no `.info`; no logger
was in scope at the call site). Each was corrected against the real module
rather than worked around. `selectAutoDefaultRival` delegating to
`buildLineForRow` removes duplicated gap/velocity arithmetic — a deepening, not
a scope widening.

**Task 4 — all ACCEPT; two are load-bearing corrections to the plan.**
1. *`assertLocationOwned` on the failure path* — the plan's design would have
   returned **409 for a foreign location and 200 for a foreign clear**, because
   zero rows from `UPDATE … WHERE b.id = … AND b.account_id = …` is ambiguous
   between "not pickable", "not yours", and "already cleared". This is a real
   tenant-isolation defect caught in implementation, and it is what makes the
   intake's own 404 test achievable. Invariant #8 holds only because of it.
2. *The concurrency tests were re-derived from a measurement* — the plan's
   lock-blocked interleaving provably cannot fail a correct implementation
   (under READ COMMITTED a blocked `UPDATE … FROM` keeps its statement snapshot
   for the joined table via EvalPlanQual; all four probe variants stored the
   removed rival). Rewritten as the real request-level race and mutation-tested:
   swapping `MAX(snapshot_date)` for `IS NOT NULL` fails only the new-date test.
   A plan-faithful implementation here would have shipped two tests that could
   never fail.
   Also accepted: the `OR rival_picked_at IS NULL` leg (prevents `.toISOString()`
   on a NULL `RETURNING`), `loadRivalPickerView` using three flat scoped reads
   instead of a CTE (keeps `ci:tenant-scope` green without more allowlist
   entries; it is a read whose worst case is rendering a just-replaced pack),
   and GET validating `businessId` as a UUID before the branded cast.

**Task 5 — all ACCEPT.** Reusing `.auto-policy-warning` avoids splitting the
settings stylesheet for one message box; ORing `views.length > 1` prevents
indistinguishable pickers on a flag-off multi-location account; extending the
sidebar test's enumeration keeps it honest about completeness.

---

## Step 5 — verify gate evidence

Final state: **every row green except `test` and `diff-coverage`**, both of
which fail for reasons external to this branch. Recorded here because a red gate
row must never be waved through silently.

- **What is green:** lint, typecheck, build, all 13 `ci:*` audits,
  `promised-tests` (all 19 intake titles verbatim), and the dedicated
  `named-rival.integration` row — which **RAN against live Postgres, it did not
  SKIP** (the #520 class the plan explicitly warned about).
- **`test` — nondeterministic Postgres deadlocks in unrelated live-DB suites.**
  Run-to-run the failing set was 13 → 5 → 4 → 6 → 2 files, never the same twice,
  always `deadlock detected` / `lock timeout` / a CHECK violated by another
  suite's rows. Multiple integration suites re-apply migrations and delete from
  the same tables in parallel against ONE shared test database.
  `migration-074-…integration.test.ts` already carries a source comment about
  "nondeterministic 40P01 deadlocks in full-suite runs" and a hand-rolled apply
  lock, so this long predates #546.
- **Proof it is contention, not a defect:** single-threaded
  (`vitest run --no-file-parallelism`) the full suite is **782/782 files, 9568
  tests passed, 0 failed**. Vitest ignores `VITEST_MAX_FORKS`/`MAX_THREADS`, so
  the gate cannot be serialized without adding `fileParallelism: false` to
  `vitest.config.ts` — a repo-wide change that would slow every CI run and
  belongs to its own ticket, not this feature.
- **`diff-coverage` is downstream only** — it needs `coverage-final.json`, which
  is not written when `test` fails. Measured directly against a completed
  coverage run: **478/507 added instrumented lines covered, 94.3% (min 80%) —
  PASS.** Uncovered: the server page's data-loading body, two client error
  branches.
- **Two test-environment repairs made while diagnosing** (test data, not code):
  deleted 8 orphaned `agent_outcomes` rows with
  `outcome_kind = 'solicitation_batch_built'` — a kind added by the later
  solicitation work that migration 074's immutable CHECK cannot contain, so
  074's idempotency test failed against them; and pointed the DB singleton at the
  local test database for the run, since `vitest.setup.ts` defaults
  `DATABASE_POOL_URL` to an unreachable placeholder that live-DB suites then hit
  through production code paths.
- **Owner decision:** proceed to review on this evidence rather than change
  repo-wide test config inside this feature.

**For step 8 lab-notes promotion, two repo-level findings beyond this feature:**
1. The parallel-shared-test-DB contention above, plus the fact that **CI hides
   it** — `TEST_DATABASE_POOL_URL` is unset there, so every one of these suites
   skips. That is exactly the #520 blind spot CLAUDE.md warns about, now
   demonstrated repo-wide rather than for one suite.
2. The immutable-CHECK migration-test landmine generalises beyond
   `analytics_events`: `agent_outcomes.outcome_kind` has the same shape, and any
   re-runnable migration test asserting an immutable CHECK will break when a
   later migration widens the domain.
