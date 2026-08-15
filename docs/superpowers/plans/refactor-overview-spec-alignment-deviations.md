# Deviations — refactor-overview-spec-alignment

Notes on things the locked plan did not anticipate. Each entry records an
observation for the plan owner.

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
