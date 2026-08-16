# Overview spec-alignment (PR 3 of 3)

Design of record: `docs/superpowers/specs/2026-08-15-portal-audit-remediation-design.md` §5.
Intake contract: `docs/superpowers/plans/refactor-overview-spec-alignment-intake.json`
(the `locked_decisions` array there is binding — read it before any task).

PR 1 shipped as #827, PR 2 as #831. This closes the spec.

## Seam statement

`src/lib/admin/` today spells the same base query twice — `overview-service.ts`
(unpaginated, no `category`) and `businesses-list-service.ts` (paginated, with
`category`). This change replaces both with **one deep module**:

| Module | Before | After |
|---|---|---|
| `business-summary.ts` | — | base query + metrics follow-up + `buildBusinessSummary` + conditional COUNT. Interface: **one** function, one optional param object, one return type. |
| `overview-service.ts` | 7 queries + metrics CTE + mapping + sort + paginate | 5 system-health queries + `deriveEmailHealth` + at-risk selection. **Shallower.** |
| `businesses-list-service.ts` | duplicate base query + COUNT | **deleted** |

Net: two shallow modules → one deep one. No interface widens; module count in
`src/lib/admin/` drops by one.

## The three traps (each cost a CI round if missed)

1. **`buildBusinessSummary` moves with its `// fallow-ignore-next-line complexity`
   comment and the 6-line rationale above it, byte-for-byte.** `ci:fallow:coverage`
   is a required check and flags the relocation otherwise (#831 lost a round to
   exactly this).
2. **Strictly sequential per #773.** Rows query → (paginated only) COUNT → metrics.
   No `Promise.all` over `sql`. React Doctor's `server-sequential-independent-await`
   argues for the fan-out #773 forbids — suppress it with the house idiom from
   `src/app/admin/businesses/[id]/page.tsx:32`, do not obey it.
3. **Trap 3 is owner-resolved** (see `locked_decisions[0]`): the row→DTO mapping
   assertions move with **assertion bodies unchanged**; the six `getAdminOverview`
   tests whose subject §5 deletes are rewritten, each logged in
   `<branch>-deviations.md` with the mandating spec line. A mapping assertion that
   needs editing is still a finding.

## Target API

```ts
// src/lib/admin/business-summary.ts — the single owner
export interface BusinessSummary { /* … + category: string | null */ }
export interface BusinessSummariesResult {
  businesses: BusinessSummary[];
  total: number;                    // rows.length unpaginated; COUNT query when paginated
  responseMetricsWindowDays: number;
}
export async function getBusinessSummaries(
  sql: Sql,
  opts?: { limit: number; offset: number },
): Promise<BusinessSummariesResult>;
```

Overview calls `getBusinessSummaries(sql)`; Businesses calls
`getBusinessSummaries(sql, { limit, offset })`.

---

## T1 — eval task (RED)

**Blocking edges:** none. Runs alone (first-task enforcement spot check).

Create `src/lib/admin/business-summary.ts` with the **real exported types** above
and `getBusinessSummaries` as a stub body (`throw new Error('T2: not implemented')`)
so `pnpm typecheck` stays green while the tests are red.

Create `src/lib/admin/__tests__/business-summary.test.ts` using the
`createMockSql` FIFO harness — precedent header + query-order comment style from
`src/lib/admin/__tests__/overview-service.test.ts:1-27`. Author these **verbatim**
titles, all failing:

- `requests metrics only for the ids on the current page`
- `requests metrics for every row when called unpaginated`
- `skips the metrics query entirely when the page has no rows`

Append to `src/lib/admin/__tests__/pool-fanout-sequential.test.ts` (precedent: the
`makeConcurrencyTrackingSql` max-concurrency===1 proxy, same file):

- `getBusinessSummaries runs its paginated bundle one query at a time`

**Do not** touch any consumer yet. Commit red.

**Definition of done:** `pnpm typecheck` green; those 4 tests fail for the right
reason (stub throw / wrong ids), not an import error.

---

## T2 — shared module implementation + Businesses data path

**Blocking edges:** T1.

Implement `getBusinessSummaries`:

- **Base query** = the superset of the two current spellings. Take
  `overview-service.ts:248-261` and add `b.category` to both the SELECT list and
  the `GROUP BY`; keep `ORDER BY b.name ASC` from `businesses-list-service.ts:64`;
  append `LIMIT/OFFSET` only when `opts` is supplied. Carry over
  `RESPONSE_METRICS_WINDOW_DAYS` and its single-owner comment
  (`overview-service.ts:18-25`) — this module becomes its owner.
- **COUNT** only when `opts` is supplied (`SELECT COUNT(*)::int AS total FROM businesses`);
  unpaginated, `total = businesses.length`. Move
  `businesses-list-service.ts:48-50`'s "not collapsed into a window `COUNT(*) OVER ()`"
  comment with it — it explains a real trap.
- **Metrics follow-up**: relocate the CTE verbatim from `overview-service.ts:266-313`,
  keyed on the ids **actually returned** (post-LIMIT). Keep the `length > 0` guard.
- **`buildBusinessSummary`**: relocate `overview-service.ts:112-156` including the
  rationale comment and `// fallow-ignore-next-line complexity` (trap 1). Add
  `category: row.category ?? null` to the returned DTO — the only mapping change.
- Sequential awaits with the house React Doctor suppression (trap 2).

Then repoint the Businesses data path:

- **Delete** `src/lib/admin/businesses-list-service.ts`.
- `src/app/admin/businesses/page.tsx` and `src/app/api/admin/businesses/route.ts`
  import `getBusinessSummaries`; the route keeps its limit/offset clamping and
  its `{ ...data, limit, offset }` echo unchanged.
- `src/app/admin/businesses/BusinessesClient.tsx`: **import repoint only** — swap
  `AdminBusinessesList` for `BusinessSummariesResult`. Columns are T3's job; do not
  add them here (T3 and T4 must stay file-disjoint).
- Fold `src/lib/admin/__tests__/businesses-list-service.test.ts` into
  `business-summary.test.ts` (both tests, assertions unchanged) and delete the file.
- Move the `buildBusinessSummary` row→DTO characterization assertions out of
  `overview-service.test.ts` into `business-summary.test.ts` with **assertion
  bodies unchanged** (trap 3): the null-date mapping, the response-rate math, the
  trend derivation, and the real-churn-score fixtures.
- **Re-key `scripts/ci/tenant-scope-allowlist.ts`**: the `businesses-list-service.ts`
  entries (lines ~284, ~1006, ~1013, ~1020) and the `overview-service.ts` entries
  covering the base + metrics queries move to `src/lib/admin/business-summary.ts`.
  Leave the entries for queries that stay in `overview-service.ts`.

**Definition of done:** T1's 4 tests green; `pnpm ci:tenant-scope` green;
`/admin/businesses` renders unchanged (columns still the old five).

---

## T3 — Businesses UI columns  *(parallel with T4)*

**Blocking edges:** T2. **Files:** `src/app/admin/businesses/BusinessesClient.tsx`,
`src/app/admin/businesses/__tests__/BusinessesClient.test.tsx` — nothing else.

Add Reconnect, Response rate, Avg time, Last activity and Health columns
alongside the existing Name, Category, Status, Last Sync, Pending (§5.4). Lift the
renderers from `src/app/admin/overview/OverviewClient.tsx:51-109` —
`HealthBadge`, `formatRelative`, and the reconnect ≥3 / >0 / 0 badge ladder — so
the two pages cannot disagree on how a level or a reconnect backlog looks. Headers
label the window from `responseMetricsWindowDays`, never a literal `30`.

Add: `renders the metric columns absorbed from Overview`.

---

## T4 — Overview at-risk list  *(parallel with T3)*

**Blocking edges:** T2. **Files:** `src/lib/admin/overview-service.ts`,
`src/lib/admin/__tests__/overview-service.test.ts`,
`src/lib/admin/__tests__/pool-fanout-sequential.test.ts`,
`src/app/admin/page-sizes.ts`, `src/app/admin/overview/**`,
`src/app/api/admin/overview/route.ts` — nothing else.

**Service.** `getAdminOverview(sql)` loses its `{ limit, offset }` parameter. It
keeps its 5 system-health queries and `deriveEmailHealth`, then calls
`getBusinessSummaries(sql)` unpaginated (sequential — it is the 6th await, not a
`Promise.all` member). Then, in this order:

1. **filter** `churnScore.level !== 'healthy'`
2. **sort** with the existing 4-level comparator, moved verbatim from
   `overview-service.ts:321-327`: score desc → `pendingApprovalCount` desc →
   name asc → id asc
3. **cap** at `OVERVIEW_AT_RISK_LIMIT`

Filter-then-cap, never cap-then-filter. `OverviewData` renames `businesses` →
`atRisk`, drops `limit`/`offset`, and `totalBusinesses` becomes the unfiltered
row count from `getBusinessSummaries` (the separate COUNT query is gone).

**Constant.** `src/app/admin/page-sizes.ts`: delete `OVERVIEW_PAGE_SIZE` (now
unused), add `/** Admin Overview — at-risk list cap (spec §5.1). */ export const
OVERVIEW_AT_RISK_LIMIT = 5;`. The file's client/server-boundary header comment
explains why it lives here — leave it intact.

**Route.** `src/app/api/admin/overview/route.ts` drops its limit/offset parsing
and clamping; `getAdminOverview(sql)` only. Keep the auth gate, the try/catch and
`reportCaughtError` exactly as they are.

**Client.** `OverviewClient.tsx`: health tiles and the needs-attention strip are
untouched. Replace the `DataTable` + `serverPagination` block with the at-risk
section — heading `At risk (N of M)` where N is `atRisk.length` and M is
`totalBusinesses`, a `View all →` link to `/admin/businesses`, rows showing name
+ `HealthBadge` linking to `/admin/businesses/<id>`, and the existing
`EmptyState` when `atRisk` is empty. Drop the `page` state and the `limit`/`offset`
query params from the `useQuery` fetcher; the 30s `refetchInterval` and the
`navCountsQueryOptions` seeding stay.

**Tests.** Add:

- `excludes every healthy business from the at-risk list`
- `orders the at-risk list by churn score descending`
- `breaks a score-and-pending tie on business name ascending` — fixture must hold
  score **and** `pendingApprovalCount` equal, so it pins the name tier specifically
- `caps the at-risk list at OVERVIEW_AT_RISK_LIMIT even when more businesses qualify`
- `returns an empty at-risk list when every business is healthy`
- `reports totalBusinesses as the number of rows read, not a separate count query`
- `renders the at-risk heading with the eligible count and the total` (client)
- `renders the EmptyState when no business is at risk` (client)

Rewrite the six superseded tests per `locked_decisions[0]`; log each in
`docs/superpowers/plans/refactor-overview-spec-alignment-deviations.md` with the
spec line that mandates it. Update `queueBaseQueries` (the FIFO fixture helper) for
the new query order and update the `getAdminOverview(sql, { limit: 20, offset: 0 })`
call in `pool-fanout-sequential.test.ts`; that suite's assertion (`toBe(1)`) must
not change.

---

## T5 — docs + domain sweep

**Blocking edges:** T3, T4.

- `docs/directory.md`: new `business-summary.ts` row; delete the
  `businesses-list-service.ts` row (line ~795); update the `overview-service.ts`
  description (line ~800).
- `CONTEXT.md`: coin **At-risk list** — the filtered-then-capped Overview list,
  eligibility `churnScore.level !== 'healthy'`, cap `OVERVIEW_AT_RISK_LIMIT`,
  ordering score desc → pending desc → name asc → id asc. Note explicitly that it
  is *not* "top 5 by score".
- Triage the deviations file (step 6) before review.

---

## Out of scope (§5.1, deliberate)

Overview still reads every business row. That is recorded in §5.1 with the
rejected alternative (a SQL-ranked attention proxy that drops the churn model from
the landing page and would disagree with the Businesses Health column). **Not an
oversight — do not "fix" it.**
