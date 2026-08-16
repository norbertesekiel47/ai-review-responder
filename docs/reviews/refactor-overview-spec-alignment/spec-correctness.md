# Spec & correctness review — `refactor/overview-spec-alignment`

_Reviewer: spec-correctness agent · 2026-08-15 · diff under review: `git diff origin/main...HEAD` (8 commits, T1–T5 + docs)_

Sources read: `.feature/intake.json` (binding contract), spec
`docs/superpowers/specs/2026-08-15-portal-audit-remediation-design.md` §5, plan
`docs/superpowers/plans/2026-08-15-overview-spec-alignment.md`, orchestrator triage
`docs/superpowers/plans/refactor-overview-spec-alignment-deviations.md`, blast radius
`docs/reviews/refactor-overview-spec-alignment/blast-radius.md`, plus `origin/main`'s
`overview-service.ts`, `businesses-list-service.ts` and their suites for the
before/after comparison.

**Verdict: the diff faithfully implements the intake contract and §5.** No behavioural
defect, no surface drift, no unhandled edge case, no missing `tests_to_add` entry, no
violated invariant. Four findings, all Medium or below; three are test-strength /
test-ownership issues and one is a documentation cross-reference.

---

## Findings

| severity | file:line | finding |
|---|---|---|
| Medium | `src/lib/admin/__tests__/overview-service.test.ts:406-455` | The comparator's `pendingApprovalCount desc` tier lost its only test pin in the T4 split — deleting it from the production comparator now makes no test fail. |
| Low | `src/lib/admin/__tests__/overview-service.test.ts:434-455` | The tie test cannot distinguish the **name** tier from the **id** tier: fixture ids `biz-z`/`biz-a` order identically to names `Zulu Co`/`Alpha Co`, so dropping `a.name.localeCompare(b.name)` still passes. |
| Low | `src/lib/admin/__tests__/overview-service.test.ts:523-562` | Orchestrator Finding A confirmed, and **wider than recorded**: the `awaiting_owner_connect` literal, `pending_reconnect_count` and `last_activity` are also pinned only through `sqlCalls[5]` from the Overview suite, not just the trailing-window `FILTER`s. |
| Low | `docs/directory.md:161,340` | Two rows still document `getAdminBusinessesList`, a function this PR deleted with `businesses-list-service.ts`. |

---

## Finding 1 (Medium) — the `pendingApprovalCount` comparator tier lost its only pin

**Contract violated:** `.feature/intake.json` → `invariants[7]`: _"The existing 4-level
comparator is preserved: churn score desc, pendingApprovalCount desc, name asc, id asc
— §5.1's 'ties break on name ascending' is the stability requirement, **not a mandate to
drop the pending-count tier**."_

The production comparator is correct and verbatim — `src/lib/admin/overview-service.ts:167-173`
matches `origin/main:src/lib/admin/overview-service.ts`'s four tiers character for
character. What changed is that nothing tests tier 2 any more.

`origin/main`'s single sort test (`sorts by churnScore.score desc, then
pendingApprovalCount desc, then name asc, then id asc`) carried a fixture built for
exactly this: `biz-tie-hi` ('Alpha Co', `pending_approval_count: 5`) had to outrank
`biz-tie-b`/`biz-tie-lo` (both `pending 2`) at an **identical** real score of 6. That is
a tier-2 discriminator.

The T4 split replaced it with two tests, neither of which reaches tier 2:

- `orders the at-risk list by churn score descending` (:406) — four **distinct** scores
  (70/55/45/38) and every row takes `businessRow()`'s default `pending_approval_count: 0`,
  so tier 1 decides every comparison.
- `breaks a score-and-pending tie on business name ascending` (:434) — both rows carry
  `pending_approval_count: 2`, deliberately **equal**, so tier 2 is a no-op by construction.

The remaining fixtures do not help: `caps the at-risk list…` (:457) and `excludes every
healthy business…` (:377) also use the default 0 for every row. Repo-wide grep for
`pendingApprovalCount` in the admin suites returns only DTO fixtures plus the *equality*
assertion at `overview-service.test.ts:454`.

**Failure scenario.** A later "simplification" of the comparator to `score → name → id`
— a plausible reading of §5.1's "ties break on business name ascending" taken literally —
lands green. Among equal-score businesses the at-risk list then orders alphabetically
instead of by workload, so the account with 12 drafts waiting sits below the one with 0.
The intake anticipated exactly this misreading and wrote an invariant against it; the
test that used to enforce it is gone.

**Not a behaviour bug** — today's output is correct. It is a regression in the guard, on
a line the contract explicitly protects. A one-line fixture change (give one of the two
tied rows a higher `pending_approval_count` and assert it ranks first) restores it.

## Finding 2 (Low) — the tie test's name tier is confounded with the id tier

`overview-service.test.ts:434-455` satisfies the brief's stated requirement — score AND
`pendingApprovalCount` are equal, verified in-test at :453-454, so tiers 1 and 2 really
are exhausted. The residual problem is the fourth tier: the fixture ids are `biz-z` and
`biz-a`, which `localeCompare` in the same order as the names `Zulu Co` and `Alpha Co`.
Remove `a.name.localeCompare(b.name) ||` from the comparator and `a.id.localeCompare(b.id)`
produces the identical expected order — the test still passes.

In production, ids are UUIDv7 (time-ordered, per the migrations-log PK convention) and
carry no relationship to the name, so name-tier removal is a genuine ordering change the
test would not catch. `origin/main` had the same confound (`biz-tie-b` < `biz-tie-lo`), so
this is not a regression — but it is a live weakness in the one test whose stated purpose
is "pins the NAME tier specifically". Fix: give the alphabetically-first business the
lexicographically-later id.

## Finding 3 (Low) — Finding A confirmed, and it covers more of the base query than recorded

I verified the orchestrator's reading independently. `getAdminOverview` issues 5
system-health queries and then delegates to `getBusinessSummaries`, so
`harness.sqlCalls[5]` in `overview-service.test.ts` is `business-summary.ts`'s base
query, reached transitively. Both assertions in the `— response-metric windowing (SQL
contract)` describe (:531, :561) index into another module's SQL.

**The sibling the deviations entry misses.** Finding A names only the trailing-window
`FILTER`s. Comparing against `origin/main`'s deleted `pins the status literals used by
the businessRows query` test, the successor in `business-summary.test.ts:252-257` carries
`FROM businesses b`, both JOINs, `resp.status != 'superseded'`,
`resp.status = 'pending_approval'` and `ORDER BY b.name ASC` — but **not**
`resp.status = 'awaiting_owner_connect'`. That literal, together with
`pending_reconnect_count` and `MAX(GREATEST(...)) AS last_activity`, survives only in
`overview-service.test.ts:546-551`. So the base query's text contract is pinned from the
wrong suite more broadly than the note says.

A second, milder instance: `overview-service.test.ts:292`
(`expect(harness.sqlCalls).toHaveLength(6)`) pins `business-summary.ts`'s empty-page
metrics skip through Overview. The deviations file states that property "is pinned
there" in `business-summary.test.ts` — it is (`skips the metrics query entirely when the
page has no rows`), so this is duplication rather than sole ownership, but the assertion
does reach across the seam.

Coverage is intact in every case — nothing was lost, only mis-homed. The consequence is
the one the orchestrator named: an edit to `business-summary.ts`'s windowing breaks the
*Overview* suite, which inverts the single-owner discipline this PR exists to establish.
Severity stays Low because no behaviour is unguarded.

## Finding 4 (Low) — `docs/directory.md` still documents a deleted function

- `docs/directory.md:161` — "`businesses/page.tsx` … Server component: gate,
  `getAdminBusinessesList`, …". The page now calls `getBusinessSummaries` and gained the
  seven absorbed columns.
- `docs/directory.md:340` — "`businesses/route.ts` | GET list (auth → parse/clamp
  `limit`/`offset` → `getAdminBusinessesList` → JSON) …". Same.

`getAdminBusinessesList` does not exist anywhere in the tree after this PR. T5 correctly
rewrote the `src/lib/admin/` rows (796, 801) but the plan's file list only named those,
and the repo working rule is broader: _"When deleting a doc or ticking a checklist item,
fix its audit tick and grep the filename to clean every cross-reference in the same
change."_ `docs/directory.md` is inside `allowed_edit_surface`. (Line 152's
`getAdminOverview` reference is still accurate.)

---

## What I verified and found correct

### Filter-then-cap (the headline risk)

`overview-service.ts:165-174` reads `.filter(level !== 'healthy')` → `.sort(comparator)`
→ `.slice(0, OVERVIEW_AT_RISK_LIMIT)`, in that order. Correct.

I then checked whether a test would catch the inversion, and the answer depends on which
inversion is meant:

- **"top 5 by score", no filter at all** (`.sort().slice(0,5)`) — the failure §5.1 names,
  "five healthy businesses under an 'At risk' heading". Caught by `returns an empty
  at-risk list when every business is healthy` (:493), which feeds six healthy rows and
  asserts `[]`, and by `excludes every healthy business…` (:377), which asserts
  `['biz-risk', 'biz-watch']` out of five rows. Both fail loudly under this mutation.
- **Literal cap-then-filter** (`.sort().slice(0,5).filter(...)`) — no test distinguishes
  it, but it is *observationally equivalent*: `churnScore.level` is a pure function of
  `churnScore.score` (thresholds in `churn-score.ts`, pinned by
  `HealthBadge.test.tsx:35-54` against `LEVEL_THRESHOLDS`), so under a score-descending
  sort every non-healthy row precedes every healthy row. Taking the top 5 and then
  filtering yields the same list as filtering and then taking 5, in every case. Not a
  gap.

`OverviewClient.tsx:101-123` renders `EmptyState` on `atRisk.length === 0`, pinned by
`OverviewClient.test.tsx:139-148` including the `At risk (0 of 12)` heading, so the
unfiltered total still shows on the empty path.

### Bounded fetch (§5.4)

`business-summary.ts:189-268`: `LIMIT/OFFSET` is applied in SQL via the `pageClause`
fragment, `businessIds` is derived from `businessRows` **after** that query returns
(:219), and the metrics CTE keys its `UNNEST` on that array (:223). Post-LIMIT ids,
as specified.

The pinning test (`business-summary.test.ts:96-123`) would fail on a re-widening in
either direction: it asserts `rowsCall.text` contains `LIMIT`/`OFFSET` with
`values.slice(-2) === [2, 2]` (so a move to TS slicing fails), and asserts
`metricsCall.values[0]` equals both the literal two page ids *and*
`result.businesses.map(b => b.id)` (so keying the CTE on a wider set fails). The empty
page skips the CTE entirely (:151-165), and `businessIds.length > 0` guards it — no empty
`UNNEST` round trip.

The `sql``` empty fragment used for the unpaginated path is an established repo idiom
(`cost-report-service.ts:138,148`, `worker/ingress/zernio/zernio.ts:193`,
`ask-generation.ts:1263`), not a novel construct.

### #773 sequencing

No `Promise.all` over `sql` anywhere in the diff — the only added occurrences of the
string are in comments forbidding it and in `pool-fanout-sequential.test.ts`'s
guards-the-guard case. Order is rows → (paginated only) COUNT → metrics
(`business-summary.ts:189, 212, 221`); Overview's `getBusinessSummaries` call is its 6th
sequential `await` (`overview-service.ts:161`); both server pages sequence their callees
(`overview/page.tsx:20-21`, `businesses/page.tsx:16`).

Guarded by `pool-fanout-sequential.test.ts:116` (`getBusinessSummaries runs its paginated
bundle one query at a time`, peak concurrency 1) and by
`admin-read-single-inflight.test.ts:56-61`, whose held-first-query discriminator is the
stronger of the two. Both suites pass.

### Comparator relocation

`overview-service.ts:167-173` is byte-identical to `origin/main`'s four-tier comparator
(score desc → `pendingApprovalCount` desc → `name` asc → `id` asc). Verified against
`git show origin/main:src/lib/admin/overview-service.ts`. Test coverage of tiers 2 and 3
is the subject of findings 1 and 2.

### `computeChurnRiskScore` unmocked

Neither `overview-service.test.ts` nor `business-summary.test.ts` mocks
`@/lib/shared/churn-score`; both import the real module transitively and pin real
outputs (0 / 2 / 6 / 31 / 38 / 40 / 45 / 55 / 65 / 70 with their levels). The
`metricsRow()` helper's doc block (:130-139) documents the real weight table it exercises.
`HealthBadge.test.tsx:35-54` additionally cross-checks the badge against
`LEVEL_THRESHOLDS` so the presentation cannot carry its own thresholds.

### `tests_to_add` — all 13 present

| entry | location |
|---|---|
| excludes every healthy business from the at-risk list | `overview-service.test.ts:377` |
| orders the at-risk list by churn score descending | `overview-service.test.ts:406` |
| breaks a score-and-pending tie on business name ascending | `overview-service.test.ts:434` |
| caps the at-risk list at OVERVIEW_AT_RISK_LIMIT even when more businesses qualify | `overview-service.test.ts:457` |
| returns an empty at-risk list when every business is healthy | `overview-service.test.ts:493` |
| reports totalBusinesses as the number of rows read, not a separate count query | `overview-service.test.ts:250` |
| requests metrics only for the ids on the current page | `business-summary.test.ts:96` |
| requests metrics for every row when called unpaginated | `business-summary.test.ts:125` |
| skips the metrics query entirely when the page has no rows | `business-summary.test.ts:151` |
| getBusinessSummaries runs its paginated bundle one query at a time | `pool-fanout-sequential.test.ts:116` |
| renders the at-risk heading with the eligible count and the total | `OverviewClient.test.tsx:115` |
| renders the EmptyState when no business is at risk | `OverviewClient.test.tsx:139` |
| renders the metric columns absorbed from Overview | `BusinessesClient.test.tsx:175` |

Titles match the intake verbatim. All 32 affected suites pass locally
(`REPWORTH_DISABLE_LIVE_DB_SUITES=1 npx vitest run src/lib/admin/__tests__ src/app/admin/overview src/app/admin/businesses src/app/api/admin/businesses src/components/admin/ui/__tests__/HealthBadge.test.tsx` → 32 files / 265 tests passed).

### `edge_cases` — all 8 handled

1. **Every business healthy → `[]` + EmptyState** — `overview-service.test.ts:493` +
   `OverviewClient.test.tsx:139`.
2. **Fewer than 5 non-healthy → short list, not padded** — `overview-service.test.ts:400`
   asserts exactly two ids from five rows.
3. **More than 5 → exactly 5, highest first** — `overview-service.test.ts:481-488`.
4. **Identical score AND pending → name ascending** — `overview-service.test.ts:451`
   (see finding 2 for the id confound).
5. **Zero businesses → metrics skipped, total 0, EmptyState** —
   `overview-service.test.ts:283` (6 queries, not 7) + `business-summary.test.ts:151`.
6. **Page beyond the last → empty rows, metrics skipped, unfiltered COUNT still returned**
   — `business-summary.test.ts:151-165` (`total` 7 with zero rows).
7. **Row with no matching metrics row → null-coalescing defaults unchanged** —
   `business-summary.test.ts:174-263` queues an empty metrics array and pins the real
   score 2 / `healthy` that `m === undefined` produces.
8. **null `last_sync_at` / `last_activity` → null, not a crash** —
   `business-summary.test.ts:287-312`, the one test that moved with byte-identical
   assertion bodies.

### `invariants` — all 8 satisfied

- **#773 one-in-flight** — see sequencing above.
- **#15 born-injected** — `business-summary.ts:158` takes `sql: Sql`; `pnpm ci:db-imports`
  passes strict ("no non-composition-root file imports db/server"). Only the two routes
  and two server pages import the singleton.
- **#1 no runtime `postgres`/LLM/bullmq import into `src/app`/`src/components`** — every
  new cross-boundary import is `import type` (`BusinessSummariesResult`, `OverviewData`,
  `ChurnScore`). `pnpm ci:static-policy` passes (1139 files).
- **#13 no `NEXT_PUBLIC_*` companion** — none added; `ci:static-policy`'s allowlist check
  is green.
- **Server-safe constants rule** — `OVERVIEW_AT_RISK_LIMIT` is exported from
  `overview-service.ts` (no `'use client'`), never from a client component;
  `page-sizes.ts:33-38` carries a pointer comment instead of a second declaration. The
  file-location deviation is owner-confirmed and out of scope per the brief; the rule the
  invariant actually protects (never exported from a client module, never re-declared)
  holds. `src/app/admin/__tests__/server-client-value-imports.test.ts` still passes.
- **`fallow-ignore-next-line complexity` relocated verbatim** — `business-summary.ts:101-107`
  is character-identical to `origin/main:src/lib/admin/overview-service.ts`'s block,
  including the "cyclomatic count (24)" prose and the marker line.
- **Filter-then-cap** — verified above.
- **4-level comparator preserved** — verified above (finding 1 is about its guard, not the
  code).

### Callers of the changed semantics (blast radius)

Typecheck catches signature breaks; I checked the two semantic changes it cannot:

- **`getAdminOverview` lost `{limit, offset}` and `businesses` → `atRisk`.** The only
  non-test callers are `src/app/admin/overview/page.tsx:20` and
  `src/app/api/admin/overview/route.ts:20`; both updated. No other module reads
  `OverviewData.businesses`, and repo-wide grep finds no consumer of
  `GET /api/admin/overview` outside `OverviewClient` (the e2e specs only assert the route
  responds). `locked_decisions[4]` explicitly waives a compat shim.
- **The React Query key `['admin-overview', page]` → `['admin-overview']`.** No other
  module references that key — no stale prefetch, no cross-component `invalidateQueries`
  left pointing at the old tuple. `OverviewClient.test.tsx:163` invalidates the new key.
- **`getAdminBusinessesList` deleted.** Three consumers moved
  (`admin-read-single-inflight.test.ts`, `api/admin/businesses/__tests__/route.test.ts`,
  `BusinessesClient.test.tsx`), all logged in the deviations file; grep confirms zero
  remaining references in `src/`, `worker/` or `scripts/`. The stale docs references are
  finding 4.
- **`totalBusinesses` changed source** — from `SELECT COUNT(*) FROM businesses` to
  `businessRows.length`. These can only differ if a `businesses` row has no matching
  `accounts` row, which the INNER `JOIN accounts a ON a.id = b.account_id` would drop.
  `businesses.account_id` is `NOT NULL REFERENCES accounts(id)` (migration
  `034_multi_location_schema.sql:88, 277`), so the two counts are provably equal. No
  user-visible delta; §5.3's "drops one query" is safe.
- **`/admin/businesses` `total` vs page rows** — the COUNT is still unfiltered while rows
  come from the join. Identical shape to `origin/main`'s `businesses-list-service.ts`;
  pre-existing and, per the NOT NULL FK above, not divergent.

### Deleted-behaviour check

Every test deleted or rewritten has a genuine successor, with one exception (finding 1):

| deleted / rewritten (main) | successor | verdict |
|---|---|---|
| `businesses-list-service.test.ts` — `maps the list page + total…` | `business-summary.test.ts:174` | widened to the superset DTO; query-contract + COUNT assertions carried over verbatim |
| `businesses-list-service.test.ts` — `returns an empty list and a zero total` | `business-summary.test.ts:265` | widened by `responseMetricsWindowDays` only |
| `maps null last_sync_at / last_activity to null` | `business-summary.test.ts:287` | moved, four `expect` lines byte-identical |
| `returns the full OverviewData shape…` | `overview-service.test.ts:166` | still a whole-payload `toEqual`; fixture made non-healthy so the list is non-empty |
| `pins the status literals used by the businessRows query` | `business-summary.test.ts:252-257` | **partial** — `awaiting_owner_connect` did not come across (finding 3) |
| `skips the metricsRows query entirely…` | `business-summary.test.ts:151` (+ `overview-service.test.ts:283`) | successor is stronger (asserts the absent `UNNEST`) |
| `sorts by score desc, then pending desc, then name asc, then id asc` | `overview-service.test.ts:406` + `:434` | **tier 2 lost** (finding 1); tiers 1 and 3 covered |
| both `— pagination` tests | `overview-service.test.ts:457` + `:493` | subject deleted by §5.3; replacements pin the cap and the all-healthy path |
| `renders a business row with the shared StatusBadge…` | `OverviewClient.test.tsx:106` | subject deleted; replacement pins the row's badge + href |
| `keeps the cached businesses table visible…` | `OverviewClient.test.tsx:150` | body unchanged apart from the query key |
| every redState / email-health test | unchanged in place | untouched, 6 of 6 |

### CI audits

`pnpm ci:tenant-scope` (396 = baseline 396), `pnpm ci:static-policy` (passed, 1139 files),
`pnpm ci:db-imports` (passed strict). The allowlist arithmetic reconciles: 400 − 4
(`businesses-list-service`) + 7 (`business-summary`, T2) − 7 (`overview-service`, T4) = 396.

---

## Appendix — low-confidence observations (deliberately not in the table)

These are below the confidence bar or belong to the sibling standards/maintainability
review. Recorded so they are not re-discovered as findings.

1. **`overview-service.ts:83`** — `deriveEmailHealth`'s comment says "Same
   estimated-coverage CRAP artifact as `buildBusinessSummary` **above**", but
   `buildBusinessSummary` moved to `business-summary.ts` in this PR. Stale
   cross-reference; no failure scenario.
2. **`pool-fanout-sequential.test.ts:116-124`** — the comment describes the bundle as
   "rows → COUNT → metrics", but the tracking `sql` yields no rows, so the metrics query
   is skipped and only two queries are actually observed. The peak-concurrency property
   under test is unaffected (the metrics call is a plain sequential `await`), and the
   `getAdminOverview` case has the same characteristic on `origin/main`. Comment is
   optimistic, coverage is adequate.
3. **`HealthBadge.tsx:26-32`** — `origin/main`'s inline copy had
   `HEALTH_BADGE_STYLES[level] ?? HEALTH_BADGE_STYLES.healthy` and
   `HEALTH_BADGE_LABELS[level] ?? level`; the extracted component drops both fallbacks in
   favour of `Record<ChurnScore['level'], …>`. Type-safe by construction, and the
   payload is validated by the same union on the server — but the client casts the fetch
   result (`res.json() as Promise<OverviewData>`), so an out-of-union `level` would render
   an empty label and an `undefined` class rather than degrading to "Healthy". Only
   reachable via a server/client version skew; the typed Record is the better trade.
4. **`BusinessesClient.tsx:69-80`** — the absorbed `pending` column has no `sortValue`,
   where Overview's deleted copy did (`sortValue: (b) => b.pendingApprovalCount`). The
   Businesses page's own `pending` column never had one on `origin/main`, so nothing
   regressed relative to that page; it is a small affordance the console loses overall.
   Not named in `user_visible_behavior` either way.
5. **`tenant-scope-allowlist.ts:107-112`** — the changelog comment records only the net
   "403 → 396" while the constant above it read 400 before this branch; the intermediate
   T2 step (400 → 403) is documented in the deviations file, not here. The final number
   is correct and the audit passes.
