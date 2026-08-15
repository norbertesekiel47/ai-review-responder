# Deviations — refactor-overview-spec-alignment

Notes on things the locked plan did not anticipate. Each entry records an
observation for the plan owner.

## Orchestrator triage (step 6) — verdicts

Read end to end before review. One verdict per entry, in file order:

| # | Entry | Verdict |
|---|---|---|
| 1 | T2 — folded tests not byte-identical | **ACCEPT** — all three changes are *widenings* forced by the superset DTO (locked decision 2) and `responseMetricsWindowDays` (decision 6); nothing weakened to `objectContaining`. Correctly distinguished from the trap-3 class. |
| 2 | T2 — which test left `overview-service.test.ts` | **ACCEPT** — the one moved test kept byte-identical assertions; the two mapping behaviours with no standalone home were ADDED rather than moved, which is the right call. (The stated reason — "removing them would leave T4 fewer than six" — is backwards; hitting six was never the goal. The outcome is correct regardless.) |
| 3 | T2 — three unnamed consumers | **ACCEPT** — all inside `allowed_edit_surface`, minimum change each. The touch on T3's test file was fixtures only; T3 confirmed no collision. |
| 4 | T2 — `pendingCount` → `pendingApprovalCount` | **ACCEPT** — forced by `tsc`. Renaming a field reference inside an existing column is not "adding a column"; T3's surface stayed intact. |
| 5 | T2 — tenant-scope 7 entries not 4 | **ACCEPT** — audit-driven, not guessed. |
| 6 | T3 — `HealthBadge` imported, not lifted | **ACCEPT** — that is T2b, executed under an owner-approved surface amendment. The import is the stronger form of the ticket's own goal. |
| 7 | T4 — `OVERVIEW_AT_RISK_LIMIT` location | **ACCEPT — owner-confirmed.** Presented to the owner with the eslint evidence; option A chosen. The locked decision's *purpose* (one source of truth for list length) is intact; only its file changed, because the specified file was illegal. |
| 8 | T4 — the six rewritten tests | **ACCEPT** — each rewrite maps to a spec line, and spot-checking #2 confirmed the SQL-contract assertions genuinely relocated to `business-summary.test.ts:252-257` rather than vanishing. See finding A below for the part that did NOT relocate. |
| 9 | T4 — two `OverviewClient` tests | **ACCEPT** — both had their subject deleted by §5.3; neither is a trap-3 mapping assertion. |
| 10 | T4 — tenant-scope 403 → 396 | **ACCEPT** — `UNUSED_ALLOWLIST_REASON` would fail on stale entries; removal was required. |

No entry rose to RE-PLAN; no locked decision was invalidated (entry 7 was
escalated to the owner rather than absorbed).

## Finding A (orchestrator) — the windowing SQL contract is pinned in the wrong suite

`getAdminOverview — response-metric windowing (SQL contract)` still lives in
`src/lib/admin/__tests__/overview-service.test.ts` (~L523-562) and asserts against
`harness.sqlCalls[5]` — which is now **`business-summary.ts`'s** base query, reached
transitively through `getAdminOverview`. `business-summary.test.ts` pins the
FROM/JOIN/status-literal/ORDER BY contract (L252-257) but **not** the trailing-window
`FILTER` (`CURRENT_DATE - ?::int`, `total_responses`, `completed_responses`,
`avg_response_time_hours`, `last_activity`), so that contract exists in exactly one
place and it is the wrong module.

Coverage is intact — nothing is lost — but ownership is inverted: editing
`business-summary.ts`'s windowing breaks the *Overview* suite. That is the precise
"single owner" discipline this PR exists to establish, so it should move.
`surfaces responseMetricsWindowDays…` is a different case: its first assertion is
genuinely `getAdminOverview`'s payload contract and belongs where it is; only its
second (`sqlCalls[5].values`) reaches across.

**Status:** raised as seeded focus context for the step-7 review agents rather than
patched pre-emptively, so the reviewers verify the reading and check for siblings.

## Finding B (orchestrator) — two `verification_commands` were wrong, and the gate caught it

Both extra commands in the locked intake were mis-specified by the orchestrator.
Corrected in both intake copies; recorded here as a deviation, **not** a surface
amendment (only `allowed_edit_surface` changes count toward the abort budget).

1. `pnpm test:coverage && pnpm ci:fallow:coverage` — `verify-gate.sh --review` runs
   its own `vitest --coverage`, and the gate runs rows in PARALLEL. Two vitest
   coverage runs sharing `coverage/.tmp` clobbered each other:
   *"Something removed the coverage directory … Make sure you are not running
   multiple Vitests with the same coverage.reportsDirectory at the same time."*
   That failed BOTH the `test` row and this row. Structurally the same mistake as
   the #643 lesson already recorded in the workflow (a destructive/duplicating
   command as a parallel peer). Re-run serially, `pnpm test` is green: **11752
   passed | 330 skipped**. Removed from `verification_commands`; `ci:fallow:coverage`
   is run serially after the gate instead.
2. `pnpm doctor` — scans the WHOLE repo and exits non-zero on the pre-existing
   backlog (16 errors: RLS-less tables in migrations, uncleaned effects, layout
   animation — none in this branch). CI's gate is
   `.github/workflows/react-doctor.yml` with `scope: changed` + `blocking: error`,
   i.e. only NEW error-level findings vs the base ref. Replaced with the matching
   invocation: `npx react-doctor@0.9.11 --scope changed --base origin/main`.
   This branch's only doctor finding is the *warning* "Sequential independent
   awaits" at `overview-service.ts:136,142` — the rule trap 2 says to defy, and its
   repo-wide count DROPPED 34 → 32 on this branch.

## T2 — the folded `businesses-list-service` tests could NOT keep byte-identical assertion bodies

The T2 ticket says to fold both tests from
`src/lib/admin/__tests__/businesses-list-service.test.ts` into
`business-summary.test.ts` "with assertion bodies unchanged". Three of their
assertions are unsatisfiable against the merged module and had to change:

1. `expect(result).toEqual({ businesses: [...], total: 42 })` — the old DTO was
   `AdminBusinessListItem` (`pendingCount`, 6 fields). The merged DTO is the
   **superset** `BusinessSummary` (`pendingApprovalCount` + the 7 metric fields +
   `churnScore`), which is the whole point of locked decision 2. The expectation
   was widened to the new DTO; nothing was weakened to `objectContaining`.
2. `expect(result).toEqual({ businesses: [], total: 0 })` — the result now also
   carries `responseMetricsWindowDays` (locked decision 6). Widened to
   `{ businesses: [], total: 0, responseMetricsWindowDays: 30 }`.
3. `expect(sqlCalls[0]!.values).toEqual([20, 0])` — the merged base query binds
   the response window and the handled-status array **before** LIMIT/OFFSET, so
   the page binds are no longer the only two. Changed to
   `values.slice(-2)`, matching the spelling T1 already used in
   `requests metrics only for the ids on the current page`.

The query-contract half of test 1 (`FROM businesses b`, the two JOINs, the three
status literals, `ORDER BY b.name ASC`) and the COUNT assertion carried over
verbatim.

**Not** the trap-3 class: trap 3 governs the `buildBusinessSummary` row→DTO
assertions moving out of `overview-service.test.ts`, and those DID move
unchanged (see next entry).

## T2 — which test left `overview-service.test.ts`, and what that leaves for T4

Exactly one test was removed from `overview-service.test.ts`:
`maps null last_sync_at / last_activity to null (not a crash on missing Date)`
(the third case in the `— shape` describe). It is purely a `buildBusinessSummary`
characterization, so it moved into `business-summary.test.ts` with its four
`expect` lines byte-identical — only the arrange/act swapped `getAdminOverview`
for `getBusinessSummaries`. A comment marking the move was left in its place.

This is what makes locked decision 1's arithmetic work: the `— shape` describe
now holds **2** tests, and those are the "2 of 3 — shape" T4 rewrites. T4 should
find six rewritable tests, not seven.

Two mapping behaviours the ticket lists — the response-rate math and the
`responseTimeTrend` derivation — had no standalone home in
`overview-service.test.ts`; they were only exercised incidentally inside
`getAdminOverview`-level tests that T4 must rewrite. Removing them there would
have left T4 fewer than six tests to rewrite, so **the source tests were left in
place** and two mapping tests were ADDED to `business-summary.test.ts` instead,
reusing the source fixtures and (for the churn scores) the source assertion
bodies verbatim:

- `maps the populated row: response-rate math and ISO dates` — the `— shape`
  fixture (10 windowed responses, 7 handled → 70%).
- `derives responseTimeTrend and pins the real churn scores it feeds` — the four
  `— churn-descending sort` metrics fixtures. Rows are queued in already-ranked
  order so the six `result.businesses[n].churnScore…` assertion bodies carry over
  byte-identical even though this module does not sort.

`computeChurnRiskScore` stays unmocked throughout; scores 65 / 6 / 6 / 6 and
level `at_risk` / `healthy` are the real function's output.

## T2 — three consumers the ticket did not name had to move with the deletion

Deleting `businesses-list-service.ts` broke three files the T2 ticket does not
list. All three are inside `allowed_edit_surface`; each got the minimum change:

1. `src/lib/admin/__tests__/admin-read-single-inflight.test.ts` — the shared
   #773 case table imported `getAdminBusinessesList`. Re-pointed to
   `getBusinessSummaries`; `queries: 2` and `rest` are unchanged (the held first
   query releases zero rows, so the metrics follow-up is skipped and the
   paginated bundle is still rows → COUNT).
2. `src/app/api/admin/businesses/__tests__/route.test.ts` — re-pointed the
   `vi.mock` and the fixture. Two envelope assertions changed because the
   payload legitimately gains `responseMetricsWindowDays` (spec §5.5, "the GET
   gains the metric fields"): the `Object.keys(body).sort()` pin and the
   empty-result `toEqual`. The limit/offset clamping tests are untouched.
3. `src/app/admin/businesses/__tests__/BusinessesClient.test.tsx` — **T3's
   file.** Its three `InitialData` fixtures no longer typecheck against
   `BusinessSummariesResult`. Widened with one shared `summaryMetrics` object and
   `responseMetricsWindowDays: 30`; **no assertion body and no rendered column
   was touched**, so T3 still owns every column and its own new test.

## T2 — one column render in `BusinessesClient.tsx` had to be renamed

The ticket says "IMPORT REPOINT ONLY … do NOT add or change any column". The
existing `pending` column reads `b.pendingCount`, which does not exist on
`BusinessSummary` (the field is `pendingApprovalCount`), so `tsc` rejects the
repoint without it. The two references inside that one existing column's
`render` were renamed. No column was added, removed or reordered — T3's surface
is intact.

## T2 — tenant-scope re-key came out at seven entries, not four

The ticket anticipated re-keying the four `businesses-list-service.ts` entries
plus "a `business-summary.ts` counterpart" for the overview base + metrics
queries. The audit's actual demand:

- 4 removed (`businesses-list-service.ts`: the COUNT + the base query × 3
  tables).
- 7 added under `src/lib/admin/business-summary.ts`: base query × 3
  (`accounts`, `businesses`, `responses`), COUNT × 1 (`businesses`), metrics CTE
  × 3 (`businesses`, `responses`, `notification_deliveries`).
- All 7 `overview-service.ts` entries stay — that file keeps its own copy of
  every query until T4.

`ALLOWLIST_BASELINE` 400 → 403. `pnpm ci:tenant-scope` green.

## T3 — `HealthBadge` was imported, not lifted

The T3 ticket says to lift three things from `OverviewClient.tsx:51-109`:
`HealthBadge`, `formatRelative`, and the reconnect badge ladder. Only two were
lifted. `HealthBadge` had already been extracted to
`src/components/admin/ui/HealthBadge.tsx` (a peer of `StatusBadge`) before T3
started, so `BusinessesClient.tsx` **imports** it. That is the stronger form of
the ticket's own stated goal — "so the two pages cannot disagree on how a level
… looks" — since one component now serves both surfaces rather than two copies
of the same JSX.

`formatRelative` and the reconnect ladder were copied as the ticket describes.
Neither leaves a second live copy behind: T4 deletes Overview's metric columns
in the same PR, so this is a move, not a duplication.

Reviewers checking the ticket line-by-line should expect an import for the
first item and copied source for the other two.

## T4 — `OVERVIEW_AT_RISK_LIMIT` could NOT live in `src/app/admin/page-sizes.ts`

Spec §5.1 says the constant lives "alongside the existing page sizes in
`src/app/admin/page-sizes.ts`, so the server page and its client component
cannot disagree about the list length", and the T4 ticket repeats it. That
placement is impossible as specified, and the reason it was specified turned out
not to hold:

1. **ESLint forbids it.** The cap is applied inside
   `src/lib/admin/overview-service.ts` (the service returns the already-capped
   `atRisk`, per §5.3/§5.5 — the payload itself is capped), and `src/lib/**` may
   not import `@/app/**`: eslint.config.mjs's `APP_LEAF_IMPORT_BAN` — "Route
   leaves (app/**) are terminal — non-route code must not import from app/."
   Verified directly:

       $ echo "import { OVERVIEW_AT_RISK_LIMIT } from '@/app/admin/page-sizes';" \
           | npx eslint --stdin --stdin-filename src/lib/admin/probe-boundary.ts
       error  '@/app/admin/page-sizes' import is restricted … no-restricted-imports

   A relative spelling is banned too (`PARENT_TRAVERSAL_BAN`).
2. **Nobody on the app side reads it.** `page.tsx` calls `getAdminOverview(sql)`
   with no arguments and `OverviewClient` renders `At risk (N of M)` from
   `atRisk.length` / `totalBusinesses`. The disagreement §5.1 wanted to prevent —
   server page vs client component — cannot occur, because neither knows the
   number.

**Resolution:** the constant is declared and exported ONCE, by the module that
applies it (`src/lib/admin/overview-service.ts`), and the test imports it from
there. `page-sizes.ts` deletes `OVERVIEW_PAGE_SIZE` as the ticket says and gains
a comment pointing at the new owner instead of a second declaration. The two
rules behind the ticket's wording are both honoured: never re-declared, and
never exported from a `'use client'` module. Re-exporting it *through*
`page-sizes.ts` was considered and rejected — that file is imported by six admin
client components, and a value re-export would put `overview-service.ts` (and
transitively `business-summary.ts` + `churn-score.ts`) in the client module
graph, which is precisely the bundler-chunking hazard the file's own header
comment exists to document.

## T4 — the six rewritten `getAdminOverview` tests

Per `locked_decisions[0]` the six tests whose subject §5 deletes were rewritten,
not deleted. Each is listed with the spec line that mandates the rewrite:

1. `returns the full OverviewData shape for a single business` →
   **`returns the full OverviewData shape for a single at-risk business`**.
   Mandated by **§5.5** ("`GET /api/admin/overview` returns `atRisk[]` in place
   of `businesses[]`") and locked decision 4 (`limit`/`offset` leave
   `OverviewData`). The `toEqual` still pins the WHOLE payload; the fixture's
   metrics changed from a healthy profile (score 0) to `approval_rate: 0.2` +
   `days_since_approval: 20` (real score 55, level `watch`) because **§5.1**
   ("only businesses whose `churnScore.level` is not `healthy` are eligible")
   means a healthy fixture would now assert an empty list and stop pinning the
   DTO at all. Query count 8 → 7.
2. `pins the status literals used by the businessRows query
   (behavior-preservation)` → **`reports totalBusinesses as the number of rows
   read, not a separate count query`**. Mandated by **§5.2** (the base query's
   single owner is `business-summary.ts`, where the identical status-literal +
   JOIN contract assertions already live, moved in T2) and **§5.3** ("Drops one
   query: `totalBusinesses` becomes `rows.length`"). The subject moved module, so
   the slot was re-spent on the behaviour that replaced it.
3. `skips the metricsRows query entirely when there are no businesses` →
   **`returns an empty at-risk list and zero totalBusinesses when the account has
   no businesses`**. Mandated by **§5.2** — the conditional metrics skip is now
   `business-summary.ts`'s property and is pinned there by T1's `skips the
   metrics query entirely when the page has no rows`. What is still
   `getAdminOverview`'s to prove is the zero-business payload. Query count 7 → 6.
4. `sorts by churnScore.score desc, then pendingApprovalCount desc, then name
   asc, then id asc` → split into the two verbatim titles **`orders the at-risk
   list by churn score descending`** and **`breaks a score-and-pending tie on
   business name ascending`**. Mandated by **§5.6** ("New: at-risk selection and
   ordering — … highest score first, ties broken on name"). Split because the
   old single test could not distinguish which comparator tier decided the tie;
   the tie fixture now holds score AND `pendingApprovalCount` equal, so it pins
   the NAME tier specifically. The comparator itself moved verbatim.
5. `slices the churn-sorted list by limit/offset and preserves totalBusinesses as
   the full count` → **`caps the at-risk list at OVERVIEW_AT_RISK_LIMIT even when
   more businesses qualify`**. Mandated by **§5.3** ("an unpaginated at-risk list
   of at most `OVERVIEW_AT_RISK_LIMIT` (5) rows") — the `.slice(offset, offset +
   limit)` this test existed for is gone, and §5.1's "`.slice()` disappears …
   because Overview stops paginating and starts ranking" is the same sentence
   read from the other side.
6. `returns an empty slice when offset is past the end of the list` →
   **`returns an empty at-risk list when every business is healthy`**. Mandated
   by **§5.1** ("An all-healthy account therefore renders the empty state rather
   than five healthy businesses under an 'At risk' heading") — the
   past-the-end-offset edge case ceased to exist with pagination, and the
   all-healthy edge case replaced it as the payload's only empty path.

`excludes every healthy business from the at-risk list` is a pure addition, not a
rewrite. `computeChurnRiskScore` stays unmocked throughout: every score and level
asserted above (0 / 6 / 31 / 38 / 40 / 45 / 55 / 70) is the real function's
output for the fixture it is given.

## T4 — two `OverviewClient` tests the ticket did not list also had to change

The T4 ticket enumerates rewrites for the service suite only, but two existing
tests in `src/app/admin/overview/__tests__/OverviewClient.test.tsx` assert
against the table §5.3 deletes. Neither is a trap-3 mapping assertion:

1. `renders a business row with the shared StatusBadge's status text` →
   **`renders an at-risk row with the shared HealthBadge, linking to the business
   detail page`**. `StatusBadge` is not in the at-risk row (§5.3: "name, level,
   score, link to detail"), so the old assertion had no subject. The replacement
   pins what the row now shows and the `/admin/businesses/<id>` href.
2. `keeps the cached businesses table visible …` → **`keeps the cached at-risk
   list visible …`**. Body unchanged apart from the query key, which lost its
   page component when the `page` state was deleted:
   `['admin-overview', 0]` → `['admin-overview']`.

The `baseData` fixture is now typed `OverviewData` rather than inferred, so the
`level` literals in the per-test overrides widen correctly; its business was
given `churnScore.level: 'at_risk'` so the list renders at all.

## T4 — tenant-scope re-key: 7 entries removed, baseline 403 → 396

T2's entry closes with "All 7 `overview-service.ts` entries stay — that file
keeps its own copy of every query until T4." T4 is that PR: the base query (×3
tables), the metrics CTE (×3 tables) and the unfiltered COUNT are gone from
`overview-service.ts`, and `ci:tenant-scope`'s `UNUSED_ALLOWLIST_REASON` check
fails on a stale entry, so all 7 were removed and `ALLOWLIST_BASELINE` dropped
403 → 396. The 3 system-health entries (`api_costs` + the two
`notification_deliveries` aggregates) stay. `scripts/ci/tenant-scope-allowlist.ts`
is inside `allowed_edit_surface` but is not named in the T4 file list — this note
is the record that T4 touched it, and why.
