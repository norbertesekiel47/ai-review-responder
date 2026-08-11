# #757 — Review-time anchor on the dashboard-payload aggregates

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development to implement
> this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bucket the reputation-flavored windows of the *rendered* dashboard payload on the
**Review-time anchor** `LEAST(review_date, detected_at)` (ADR 0019), make `src/lib/kpi/fragments.ts`
the single owner of that spelling, and delete the consumer-less Stack A KPI service + `GET /api/dashboard/kpis`.

**Architecture:** #688 shipped the anchor into `src/lib/kpi/service.ts` ("Stack A"), which nothing
renders. The dashboard owners actually see ("Stack B") is `src/lib/dashboard/service.ts` +
`aggregate-queries.ts`, still on `detected_at`. This plan moves the two anchor fragments into a
module both stacks can import, composes them at 17 plug sites in Stack B, then deletes Stack A
whole. No migration, no new index, no interface change on any surviving function.

**Tech Stack:** Postgres.js lazy fragments, vitest (`worker/__tests__/helpers/mock-sql.ts` harness
for SQL-shape pins, `describeWithDb` + `assertSchemaReady` for the live-DB eval suite), Next.js
route deletion.

**Decisions of record:** ADR 0019 (`docs/adr/0019-kpi-review-time-anchor.md`) ·
`docs/reviews/PATHFINDER-2026-08-10/03-unified-proposal.md` P1 · issue #757 ·
intake `docs/superpowers/plans/feat-757-dashboard-review-time-anchor-intake.json`

---

## Glossary (CONTEXT.md, verbatim — use these terms in code, comments and commits)

- **Review-time anchor** — `LEAST(review_date, detected_at)`, the timestamp reputation KPIs bucket
  on so a consented **Review import** lands in its true months/weeks. LEAST ignores NULLs (NULL
  `review_date` → `detected_at`) and clamps a clock-skewed future `review_date` to `detected_at`.
- **Review import** — the consented one-time storage of an owner's Google reviews, `detected_at` =
  import time, `review_date` = the original Google timestamp.
- **Reputation KPI** vs **workflow KPI** — reputation answers "what did customers say, and when"
  (anchored); workflow answers "what happened on this account" (stays on `detected_at`).

## Modules & seams (codebase-design pass)

| Module | Interface change? | Verdict |
|---|---|---|
| `src/lib/kpi/fragments.ts` (**new**) | New: 2 factories returning lazy fragments | Not a variation seam — a **single-owner spelling** module. Deletion test: removing it respells the LEAST/NULL-skip/future-clamp invariant at 17 sites across 2 files. Precedent: `openFlagExistsSql` (#730). |
| `src/lib/dashboard/service.ts` → `getActiveDashboardData` | **None** | Deepening: same interface, more correct behavior behind it. |
| `src/lib/dashboard/aggregate-queries.ts` → `fetchPerLocationAggregateSlices` | **None** | Deepening. |
| `src/lib/kpi/service.ts`, `src/app/api/dashboard/kpis/route.ts` | **Deleted** | Reverse deletion test: zero complexity reappears (zero consumers). |
| `src/lib/kpi/types.ts` | **Narrows** (5 orphan exports removed) | Window vocabulary keeps its 9 importers. |

**Anti-slop guard to carry into the module doc comment:** nothing varies across this seam. Do NOT
later add an "anchor strategy" / registry / injected-clock abstraction behind it. Two exports, one
spelling, many composers.

## File structure

**Create**
- `src/lib/kpi/fragments.ts` — anchor fragment owner
- `src/lib/kpi/__tests__/fragments.test.ts` — fragment unit pins
- `src/lib/dashboard/__tests__/review-time-anchor.integration.test.ts` — live-DB eval suite (moved + re-pointed from `src/lib/kpi/__tests__/service.anchor.integration.test.ts`)
- `src/lib/dashboard/__tests__/service.review-time-anchor.test.ts` — SQL-shape pins for Stack B single-location
- `src/lib/dashboard/__tests__/aggregate-queries.review-time-anchor.test.ts` — SQL-shape pins for Stack B aggregate

**Modify**
- `src/lib/dashboard/service.ts` — 14 plug lines (velocity, rating breakdown, avg star, sentiment trend)
- `src/lib/dashboard/aggregate-queries.ts` — 3 plug lines + `rv`/`rev` → `r` alias rename
- `src/lib/kpi/types.ts` — drop 5 orphan exports
- `scripts/ci/__tests__/db-imports-audit.test.ts:102` — stale route path
- `docs/adr/0019-kpi-review-time-anchor.md`, `CONTEXT.md`, `.claude/CLAUDE.md`, `docs/directory.md`

**Delete**
- `src/lib/kpi/service.ts`, `src/lib/kpi/__tests__/service.test.ts`, `src/lib/kpi/__tests__/service.cache.test.ts`
- `src/app/api/dashboard/kpis/route.ts`, `src/app/api/dashboard/kpis/__tests__/route.test.ts`

## Task graph

```
T1 (eval) ─→ T2 (fragments) ─┬─→ T3 (service.ts plugs) ─┐
                             └─→ T4 (aggregate plugs) ───┴─→ T5 (delete Stack A) ─→ T6 (docs)
```

**T3 and T4 are mutually independent** — no blocking edge between them and disjoint edited file
sets (T3: `service.ts` + `service.review-time-anchor.test.ts`; T4: `aggregate-queries.ts` +
`aggregate-queries.review-time-anchor.test.ts`). Both depend on T2. Eligible for parallel dispatch
*after* T1's enforcement spot check passes.

---

### Task 1: Eval — author every promised test as a failing spec

**Files:**
- Create: `src/lib/dashboard/__tests__/review-time-anchor.integration.test.ts`
- Create: `src/lib/dashboard/__tests__/service.review-time-anchor.test.ts`
- Create: `src/lib/dashboard/__tests__/aggregate-queries.review-time-anchor.test.ts`
- Create: `src/lib/kpi/__tests__/fragments.test.ts`
- Delete: `src/lib/kpi/__tests__/service.anchor.integration.test.ts` (its scaffolding moves)

- [ ] **Step 1: Move the live-DB suite and re-point it at the rendered stack**

`git mv src/lib/kpi/__tests__/service.anchor.integration.test.ts src/lib/dashboard/__tests__/review-time-anchor.integration.test.ts`, then rewrite.

**Port VERBATIM from the moved file** (do not re-invent — it encodes hard-won live-DB conventions):
the header's live-DB + accepted-timing-risk notes, the `vi.mock('@/lib/db/redis-cache', ...)`
always-miss stub, `POSTED`, `testDatabaseUrl`, `sql()`, `SeedReviewSpec`, `seedReview`,
`seedPostedResponse`, the `assertSchemaReady(db, [MIGRATION_071_RUN_SPINE])` call, and the
`afterAll` FK-ordered cleanup loop.

**Change these:**

```typescript
// import: Stack B replaces Stack A
import { getActiveDashboardData } from '../service';
import { fetchPerLocationAggregateSlices } from '../aggregate-queries';

// one isolated business per concern
const VELOCITY_BIZ = randomUUID();   // test 1 — velocity week bucketing
const TREND_BIZ = randomUUID();      // test 2 — sentiment-trend week bucketing
const STAR_BIZ = randomUUID();       // test 3 — avg-star window membership
const RATING_BIZ = randomUUID();     // test 4 — rating-breakdown window membership
const NULLFB_BIZ = randomUUID();     // test 5 — NULL review_date fallback
const FUTURE_BIZ = randomUUID();     // test 6 — future review_date clamp
const RATE_BIZ = randomUUID();       // test 7 — response-rate detected_at pin (negative control)
const FEED_BIZ = randomUUID();       // test 8 — recent-review feed detected_at pin (negative control)
const AGG_BIZ = randomUUID();        // test 9 — aggregate slice anchor
const ALL_BIZ = [VELOCITY_BIZ, TREND_BIZ, STAR_BIZ, RATING_BIZ, NULLFB_BIZ,
                 FUTURE_BIZ, RATE_BIZ, FEED_BIZ, AGG_BIZ] as const;

// seedLocation: businesses_account_primary_uniq permits ONE primary per account
isPrimary: bizId === VELOCITY_BIZ,

// helper — every reputation assertion needs the opt-in batch
async function rep(bizId: string) {
  return getActiveDashboardData(sql(), bizId, { includeReputationMetrics: true });
}
```

Fixtures (all time arithmetic in SQL — never a JS `Date`):

```typescript
// Test 1 — imported review written three weeks back (Monday-aligned), stored today.
await seedReview(VELOCITY_BIZ, {
  star: 4,
  reviewDate: sql()`DATE_TRUNC('week', NOW()) - interval '21 days'`,
  detectedAt: sql()`NOW()`,
});
// Test 2 — same shape, plus a sentiment score so the trend has a value.
await seedReview(TREND_BIZ, {
  star: 4, sentimentScore: 0.8,
  reviewDate: sql()`DATE_TRUNC('week', NOW()) - interval '21 days'`,
  detectedAt: sql()`NOW()`,
});
// Test 3 — a 1★ import 60 days back (outside the 30d review-time window) beside an
// organic in-window 5★. Anchored: avg = 5. On detected_at: avg = 3.
await seedReview(STAR_BIZ, { star: 1, reviewDate: sql()`NOW() - interval '60 days'`, detectedAt: sql()`NOW()` });
await seedReview(STAR_BIZ, { star: 5, reviewDate: sql()`NOW() - interval '1 day'`, detectedAt: sql()`NOW() - interval '1 day'` });
// Test 4 — same shape for the rating breakdown.
await seedReview(RATING_BIZ, { star: 1, reviewDate: sql()`NOW() - interval '60 days'`, detectedAt: sql()`NOW()` });
await seedReview(RATING_BIZ, { star: 5, reviewDate: sql()`NOW() - interval '1 day'`, detectedAt: sql()`NOW() - interval '1 day'` });
// Test 5 — no review_date at all: LEAST ignores NULLs, anchor falls back to detected_at.
await seedReview(NULLFB_BIZ, { star: 4, sentimentScore: 0.4, reviewDate: null, detectedAt: sql()`NOW()` });
// Test 6 — provider clock skew: FUTURE review_date clamps to detected_at. A naive
// COALESCE would bucket it into a week generate_series never emits, vanishing it.
await seedReview(FUTURE_BIZ, { star: 3, sentimentScore: 0.5, reviewDate: sql()`NOW() + interval '2 days'`, detectedAt: sql()`NOW()` });
// Test 7 — imported UNANSWERED review, ancient review_date, stored today.
await seedReview(RATE_BIZ, { star: 2, reviewDate: sql()`NOW() - interval '200 days'`, detectedAt: sql()`NOW()` });
// Test 8 — imported review (ancient review_date) beside an older-detected organic one.
await seedReview(FEED_BIZ, { star: 2, reviewDate: sql()`NOW() - interval '200 days'`, detectedAt: sql()`NOW()` });
await seedReview(FEED_BIZ, { star: 5, reviewDate: sql()`NOW() - interval '2 days'`, detectedAt: sql()`NOW() - interval '2 days'` });
// Test 9 — aggregate: one import three weeks back, one organic this week.
await seedReview(AGG_BIZ, { star: 1, reviewDate: sql()`DATE_TRUNC('week', NOW()) - interval '21 days'`, detectedAt: sql()`NOW()` });
await seedReview(AGG_BIZ, { star: 5, reviewDate: sql()`NOW() - interval '1 day'`, detectedAt: sql()`NOW() - interval '1 day'` });
```

Tests (titles **verbatim** — `promised-tests` matches them exactly):

```typescript
it('velocity buckets an imported review into its review_date week, not the import week', async () => {
  const data = await rep(VELOCITY_BIZ);
  const [{ week_start: importWeek }] = await sql()<{ week_start: string }[]>`
    SELECT DATE_TRUNC('week', NOW())::date::text AS week_start`;
  const [{ week_start: reviewWeek }] = await sql()<{ week_start: string }[]>`
    SELECT (DATE_TRUNC('week', NOW()) - interval '21 days')::date::text AS week_start`;
  const at = (wk: string) => data.reviewVelocity.find((p) => p.weekStart.startsWith(wk))?.count ?? 0;
  expect(at(reviewWeek)).toBe(1);
  expect(at(importWeek)).toBe(0);
});

it('sentiment trend buckets an imported review into its review_date week, not the import week', async () => {
  const data = await rep(TREND_BIZ);
  const [{ week_start: importWeek }] = await sql()<{ week_start: string }[]>`
    SELECT DATE_TRUNC('week', NOW())::date::text AS week_start`;
  const [{ week_start: reviewWeek }] = await sql()<{ week_start: string }[]>`
    SELECT (DATE_TRUNC('week', NOW()) - interval '21 days')::date::text AS week_start`;
  const at = (wk: string) => data.reputationSummary!.trend.find((p) => p.weekStart.startsWith(wk));
  expect(at(reviewWeek)?.reviewCount).toBe(1);
  expect(at(importWeek)?.reviewCount).toBe(0);
});

it('avg star window excludes a review whose review_date is outside the window even though detected_at is inside', async () => {
  const data = await rep(STAR_BIZ);
  // Anchored: only the organic 5★ is in the 30d review-time window.
  // On detected_at both are in-window and this reads 3.
  expect(data.reputationSummary!.averageStar.current).toBe(5);
});

it('rating breakdown excludes a review whose review_date is outside the window even though detected_at is inside', async () => {
  const data = await rep(RATING_BIZ);
  expect(data.ratingBreakdown.total).toBe(1);
  expect(data.ratingBreakdown.counts.find((c) => c.stars === 5)?.count).toBe(1);
  expect(data.ratingBreakdown.counts.find((c) => c.stars === 1)?.count).toBe(0);
});

it('review-time anchor falls back to detected_at when review_date is NULL', async () => {
  const data = await rep(NULLFB_BIZ);
  // LEAST(NULL, detected_at) = detected_at, so the row participates normally.
  expect(data.reputationSummary!.averageStar.current).toBe(4);
  expect(data.ratingBreakdown.total).toBe(1);
  expect(data.reviewVelocity.reduce((n, p) => n + p.count, 0)).toBe(1);
});

it('review-time anchor clamps a future review_date to detected_at', async () => {
  const data = await rep(FUTURE_BIZ);
  const [{ week_start: thisWeek }] = await sql()<{ week_start: string }[]>`
    SELECT DATE_TRUNC('week', NOW())::date::text AS week_start`;
  // Clamped to detected_at = this week. Unclamped it lands in a week
  // generate_series never emits and vanishes from both series entirely.
  expect(data.reviewVelocity.find((p) => p.weekStart.startsWith(thisWeek))?.count).toBe(1);
  expect(data.reputationSummary!.trend.find((p) => p.weekStart.startsWith(thisWeek))?.reviewCount).toBe(1);
  expect(data.reviewVelocity.reduce((n, p) => n + p.count, 0)).toBe(1);
});

it('response rate still windows on detected_at so imported unanswered reviews drag the rate', async () => {
  const data = await rep(RATE_BIZ);
  // NEGATIVE CONTROL — green before and after the re-anchor. Workflow KPI,
  // ADR 0019 D2: the import counts as received and drags the rate to 0%.
  expect(data.reputationSummary!.responseRate.current).toBe(0);
});

it('recent-review feed still orders on detected_at so an imported review surfaces by ingestion recency', async () => {
  const data = await rep(FEED_BIZ);
  // NEGATIVE CONTROL — the feed is ingestion recency, not review time. The
  // 200-day-old import was detected today, so it leads.
  expect(data.recentReviews[0]?.starRating).toBe(2);
});

it('aggregate slices apply the same review-time anchor to velocity and rating breakdown', async () => {
  const slices = await fetchPerLocationAggregateSlices(sql(), tenant!.accountId, '30d');
  const slice = slices.get(AGG_BIZ)!;
  const [{ week_start: reviewWeek }] = await sql()<{ week_start: string }[]>`
    SELECT (DATE_TRUNC('week', NOW()) - interval '21 days')::date::text AS week_start`;
  expect(slice.reviewVelocity.find((p) => p.weekStart.startsWith(reviewWeek))?.count).toBe(1);
  expect(slice.ratingBreakdown.total).toBe(1);
  expect(slice.ratingBreakdown.counts.find((c) => c.stars === 5)?.count).toBe(1);
});
```

- [ ] **Step 2: Author the single-location SQL-shape pins**

`src/lib/dashboard/__tests__/service.review-time-anchor.test.ts` — follow
`service.rating-breakdown.test.ts` exactly (same mock harness, same Redis stub, same seed pattern).
The `createMockSql` harness flattens nested fragments into `call.text`, so a composed fragment is
visible as literal SQL.

```typescript
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import { createMockSql, type MockSqlHarness } from '../../../../worker/__tests__/helpers/mock-sql';

vi.mock('@/lib/db/redis-cache', () => ({
  getCacheRedis: () => ({ get: async () => null, set: async () => 'OK' }),
}));

import { getActiveDashboardData } from '../service';

let harness: MockSqlHarness;
let mockSql: Sql;
const BUSINESS_ID = 'biz-anchor-1';

// Sequential settledInOrder call order (with includeReputationMetrics):
// 0 business, 1 totalReviews, 2 totalResponded, 3 velocity, 4 ranking,
// 5 recentReviews, 6 monthlyBrief, 7 weeklyBrief, 8 zernioConn,
// 9 queuedReconnect, 10 unresolvedIncident, 11 ratingBreakdown,
// then the reputation batch: 12 rate, 13 star, 14 timeSaved, 15 trend, 16 pendingCount.
function seed() {
  harness.resetMockSql();
  harness.sqlReturnQueue.push(
    [{ name: 'Biz', created_at: new Date('2026-01-01T00:00:00Z') }],
    [{ count: 0 }], [{ count: 0 }], [], [], [], [], [], [], [], [], [],
    [{ received_current: 0, handled_current: 0, received_prior: 0, handled_prior: 0 }],
    [{ star_current: null, star_n_current: 0, star_prior: null, star_n_prior: 0 }],
    [{ handled_current: 0, handled_prior: 0 }],
    [],
    [{ count: 0 }],
  );
}

const find = (needle: string) => harness.sqlCalls.find((c) => c.text.includes(needle))?.text ?? '';

describe('getActiveDashboardData — Review-time anchor (#757, ADR 0019)', () => {
  beforeEach(() => {
    harness = createMockSql();
    mockSql = harness.mockSql as unknown as Sql;
  });

  it('velocity, avg star, sentiment trend and rating breakdown queries all spell LEAST(review_date, detected_at)', async () => {
    seed();
    await getActiveDashboardData(mockSql, BUSINESS_ID, { includeReputationMetrics: true });
    const velocity = find('COALESCE(r.cnt, 0)');
    const star = find('star_n_current');
    const trend = find('AVG(sentiment_score)');
    const rating = find('GROUP BY star_rating');
    for (const [name, text] of Object.entries({ velocity, star, trend, rating })) {
      expect(text, `${name} query must compose the Review-time anchor`).toContain(
        'LEAST(review_date, detected_at)',
      );
      expect(text, `${name} query must not window on bare detected_at`).not.toMatch(
        /(?<!LEAST\(review_date, )detected_at >= NOW\(\)/,
      );
    }
  });

  it('response-rate and timeSaved queries never spell LEAST(', async () => {
    seed();
    await getActiveDashboardData(mockSql, BUSINESS_ID, { includeReputationMetrics: true });
    // NEGATIVE CONTROL — workflow KPI + action timestamp, ADR 0019 D2.
    expect(find('received_current')).not.toContain('LEAST(');
    expect(find('handled_prior')).not.toContain('LEAST(');
    expect(find('received_current')).toContain('r.detected_at >= NOW()');
  });
});
```

- [ ] **Step 3: Author the aggregate SQL-shape pins**

`src/lib/dashboard/__tests__/aggregate-queries.review-time-anchor.test.ts` — model the seeding on the
existing `aggregate-queries.test.ts` (8-member `settledInOrder` wave: 0 baseline, 1 counters,
2 velocity, 3 rating, 4 ranking, 5 monthly, 6 weekly, 7 pending).

```typescript
it('aggregate velocity and rating-breakdown queries spell LEAST(r.review_date, r.detected_at)', async () => {
  seed();
  await fetchPerLocationAggregateSlices(mockSql, ACCOUNT_ID, '30d');
  const velocity = find('CROSS JOIN generate_series');
  const rating = find('GROUP BY b.id, r.star_rating');
  expect(velocity).toContain('LEAST(r.review_date, r.detected_at)');
  expect(rating).toContain('LEAST(r.review_date, r.detected_at)');
  // Aliases renamed to r. so the fragment's '' | 'r.' union covers both.
  expect(velocity).not.toContain('rv.');
  expect(rating).not.toContain('rev.');
});

it('aggregate review-counter query never spells LEAST(', async () => {
  seed();
  await fetchPerLocationAggregateSlices(mockSql, ACCOUNT_ID, '30d');
  // NEGATIVE CONTROL — received_window/responded_window feed the account
  // response rate, a workflow KPI (ADR 0019 D2).
  const counters = find('total_received_all_time');
  expect(counters).not.toContain('LEAST(');
  expect(counters).toContain('r.detected_at >= NOW()');
});
```

- [ ] **Step 4: Author the fragment unit pins as `.todo`**

`src/lib/kpi/__tests__/fragments.test.ts`. The module does not exist yet, so these two are `.todo`
in this task and **T2 converts them to real tests** — a `.todo` satisfies the `promised-tests` gate
while proving nothing, so leaving one behind is a review-blocking defect.

```typescript
import { describe, it } from 'vitest';

describe('kpi/fragments — Review-time anchor owner (#757)', () => {
  it.todo('reviewTimeAnchor emits the unprefixed and r.-prefixed spellings and nothing else');
  it.todo('reviewTimeWindowFilter binds the window as an integer parameter, never interpolated text');
});
```

- [ ] **Step 5: Run the eval suite and confirm the expected RED/GREEN split**

```bash
cd /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-757-dashboard-review-time-anchor
pnpm vitest run src/lib/dashboard/__tests__/service.review-time-anchor.test.ts \
  src/lib/dashboard/__tests__/aggregate-queries.review-time-anchor.test.ts 2>&1 | tail -30
TEST_DATABASE_POOL_URL="$TEST_DATABASE_POOL_URL" pnpm vitest run \
  src/lib/dashboard/__tests__/review-time-anchor.integration.test.ts 2>&1 | tail -40
```

Expected — this exact split is the eval's contract, record it in the commit body:

| Test | Expected now |
|---|---|
| 1 velocity week bucketing | **FAIL** |
| 2 sentiment trend week bucketing | **FAIL** |
| 3 avg star window | **FAIL** (reads 3, want 5) |
| 4 rating breakdown window | **FAIL** (total 2, want 1) |
| 5 NULL review_date fallback | PASS (equivalent under both anchors — regression guard) |
| 6 future review_date clamp | **FAIL** on a Sat/Sun run, PASS midweek (documented in the ported header) |
| 7 response rate on detected_at | PASS (negative control) |
| 8 feed on detected_at | PASS (negative control) |
| 9 aggregate slice anchor | **FAIL** |
| 10 shape: LEAST in 4 queries | **FAIL** |
| 11 shape: no LEAST in rate/timeSaved | PASS (negative control) |
| 12 shape: LEAST in aggregate | **FAIL** |
| 13 shape: no LEAST in counters | PASS (negative control) |
| 14–15 fragment pins | `.todo` |

If a test in the FAIL column passes, the fixture is not exercising the anchor — fix the fixture
before proceeding. **Do not weaken an assertion to make the split come out right.**

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "test(#757): eval — Review-time anchor on the rendered dashboard stack

Live-DB suite moved from kpi/__tests__ and re-pointed at getActiveDashboardData
+ fetchPerLocationAggregateSlices, plus SQL-shape pins and two negative controls
(response rate + recent-review feed stay on detected_at, ADR 0019 D2)."
```

---

### Task 2: Extract the anchor fragments into their single owner

**Blocking edges:** T1.

**Files:**
- Create: `src/lib/kpi/fragments.ts`
- Modify: `src/lib/kpi/service.ts` (import instead of define — Stack A still alive here)
- Modify: `src/lib/kpi/__tests__/fragments.test.ts` (`.todo` → real)

- [ ] **Step 1: Create the fragment module**

```typescript
// src/lib/kpi/fragments.ts
//
// Single owner of the Review-time anchor spelling (#688 ADR 0019, consolidated
// by #757). Extracted from kpi/service.ts so the RENDERED dashboard stack
// (dashboard/service.ts + dashboard/aggregate-queries.ts) composes the same
// bucketing decision instead of re-spelling it.
//
// Each factory returns a lazy Postgres.js fragment (a nested sql`` template —
// never awaited on its own; it composes into a caller's template text + bound
// params). Neither spells a FROM/JOIN nor a tenant-scope predicate, so neither
// can hide — or need — a tenant-scope predicate of its own: every caller keeps
// `business_id = `/`account_id = ` written out literally in its own template,
// because scripts/ci/tenant-scope-audit.ts reads only raw, un-evaluated
// template text. Do NOT move a tenant predicate or a FROM/JOIN in here.
//
// NOT A VARIATION SEAM. Nothing varies across this module — it exists for
// LOCALITY of one load-bearing spelling (the openFlagExistsSql precedent,
// #730). Do not add an "anchor strategy", a registry, or an injected clock
// behind it; if a second bucketing rule is ever needed, that is a new ADR.

import type { Sql } from 'postgres';

/** Table alias prefix at a composition site. Callers alias `reviews` as `r`. */
type ReviewsPrefix = '' | 'r.';

/**
 * Review-time anchor (#688, ADR 0019) — the timestamp the reputation KPIs
 * (review volume, sentiment trend, avg star, velocity, rating breakdown)
 * bucket on, so a consented Review import lands in its true months/weeks
 * instead of spiking the import month.
 *
 * LEAST ignores NULLs in Postgres: a NULL review_date falls back to
 * detected_at, and a clock-skewed FUTURE review_date clamps to detected_at
 * (unclamped, a future week silently vanishes from a trend's generate_series
 * LEFT JOIN). The anchor can never exceed detected_at.
 *
 * Workflow KPIs — response rate, the MonthlyImpactWorker digest — deliberately
 * stay on detected_at: imported unanswered reviews are MEANT to drag the rate
 * (#675 nudge reasoning, ADR 0019 D2). Action timestamps (approved_at) never
 * use this.
 */
export function reviewTimeAnchor(sql: Sql, prefix: ReviewsPrefix) {
  return prefix === 'r.'
    ? sql`LEAST(r.review_date, r.detected_at)`
    : sql`LEAST(review_date, detected_at)`;
}

/**
 * Single-sided rolling review-time lookback in DAYS. Two-sided (current vs
 * prior) buckets and week-based lookbacks compose {@link reviewTimeAnchor}
 * directly instead — one fragment per predicate shape, not per call site.
 * The window reaches SQL only as a bound integer via make_interval (#403).
 */
export function reviewTimeWindowFilter(sql: Sql, prefix: ReviewsPrefix, windowDays: number) {
  return sql`${reviewTimeAnchor(sql, prefix)} >= NOW() - make_interval(days => ${windowDays})`;
}
```

- [ ] **Step 2: Point Stack A at the module (pure move, no behavior change)**

In `src/lib/kpi/service.ts`, delete the local `reviewTimeAnchor` and `reviewTimeWindowFilter`
definitions (currently lines ~134–154) and add to the import block:

```typescript
import { reviewTimeAnchor, reviewTimeWindowFilter } from './fragments';
```

Leave `notDeletedFilter`, `detectedAtWindowFilter`, `handledStatusFilter`, `ttrSelectExpr` and
`ttrHandledWindowFilter` where they are — they die with this file in T5, and extracting a fragment
with zero surviving composers is dead code (intake non-goal).

- [ ] **Step 3: Convert the two `.todo` pins to real tests**

```typescript
import { describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { createMockSql } from '../../../../worker/__tests__/helpers/mock-sql';
import { reviewTimeAnchor, reviewTimeWindowFilter } from '../fragments';

describe('kpi/fragments — Review-time anchor owner (#757)', () => {
  it('reviewTimeAnchor emits the unprefixed and r.-prefixed spellings and nothing else', () => {
    const harness = createMockSql();
    const sql = harness.mockSql as unknown as Sql;
    const bare = harness.sqlCalls;
    // Compose into a host template so the harness records the flattened text.
    void sql`SELECT ${reviewTimeAnchor(sql, '')} AS a`.then?.(() => {});
    void sql`SELECT ${reviewTimeAnchor(sql, 'r.')} AS a`.then?.(() => {});
    const texts = bare.map((c) => c.text);
    expect(texts[0]).toBe('SELECT LEAST(review_date, detected_at) AS a');
    expect(texts[1]).toBe('SELECT LEAST(r.review_date, r.detected_at) AS a');
    // No FROM/JOIN and no tenant predicate may ever live in the fragment —
    // ci:tenant-scope reads raw template text and would stop seeing it.
    for (const t of texts) {
      expect(t).not.toMatch(/\bFROM\b|\bJOIN\b|business_id|account_id/);
    }
  });

  it('reviewTimeWindowFilter binds the window as an integer parameter, never interpolated text', () => {
    const harness = createMockSql();
    const sql = harness.mockSql as unknown as Sql;
    void sql`SELECT 1 WHERE ${reviewTimeWindowFilter(sql, '', 30)}`.then?.(() => {});
    const call = harness.sqlCalls[0]!;
    expect(call.text).toContain('LEAST(review_date, detected_at) >= NOW() - make_interval(days => ?)');
    expect(call.text).not.toMatch(/INTERVAL\s+'\d+\s+days'/i);
    expect(call.values).toContain(30);
  });
});
```

> If the harness's fragment flattening only records on `await`, await each host template instead of
> the `.then?.()` nudge — `sqlCalls` is the awaited, fragment-flattened view. Adjust to whichever
> the harness actually does; the assertions themselves do not change.

- [ ] **Step 4: Verify — Stack A is unchanged, fragments are pinned**

```bash
cd /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-757-dashboard-review-time-anchor
pnpm vitest run src/lib/kpi/__tests__ 2>&1 | tail -20
```

Expected: `fragments.test.ts` 2 PASS (no `.todo` remaining), `service.test.ts` and
`service.cache.test.ts` still fully PASS — this task must not change Stack A's behavior by one byte.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "refactor(#757): extract reviewTimeAnchor + reviewTimeWindowFilter to kpi/fragments.ts

Pure move, no behavior change — Stack A composes them from the new owner.
Single-owner spelling, not a variation seam (openFlagExistsSql precedent, #730)."
```

---

### Task 3: Re-anchor `dashboard/service.ts` (14 plug lines)

**Blocking edges:** T2. **Mutually independent with T4.**

**Files:** Modify `src/lib/dashboard/service.ts`

- [ ] **Step 1: Import the fragments**

```typescript
import { reviewTimeAnchor, reviewTimeWindowFilter } from '@/lib/kpi/fragments';
```

- [ ] **Step 2: Velocity (lines 246, 249, 251)** — inside the `LEFT JOIN` subquery

```typescript
      LEFT JOIN (
        SELECT DATE_TRUNC('week', ${reviewTimeAnchor(sql, '')})::date AS wk, COUNT(*) AS cnt
        FROM reviews
        WHERE business_id = ${businessId}
          AND ${reviewTimeAnchor(sql, '')} >= NOW() - make_interval(weeks => ${trendWeeks})
          AND status <> ${REVIEW_STATUS.DELETED}
        GROUP BY DATE_TRUNC('week', ${reviewTimeAnchor(sql, '')})
      ) r ON r.wk = gs::date
```

Week-based lookback composes the anchor directly — `reviewTimeWindowFilter` is days-only.

- [ ] **Step 3: Rating breakdown (line 371)**

```typescript
      SELECT star_rating AS stars, COUNT(*)::int AS count
      FROM reviews
      WHERE business_id = ${businessId}
        AND status <> ${REVIEW_STATUS.DELETED}
        AND star_rating IS NOT NULL
        AND ${reviewTimeWindowFilter(sql, '', windowDays)}
      GROUP BY star_rating
```

- [ ] **Step 4: Avg star (lines 518, 521, 524, 525, 528, 529, 535)** — whole `starRows` query

```typescript
  const starRows = await sql<StarWindowRow[]>`
        SELECT
          AVG(star_rating) FILTER (
            WHERE ${reviewTimeAnchor(sql, '')} >= NOW() - make_interval(days => ${windowDays})
          )::float AS star_current,
          COUNT(star_rating) FILTER (
            WHERE ${reviewTimeAnchor(sql, '')} >= NOW() - make_interval(days => ${windowDays})
          )::int AS star_n_current,
          AVG(star_rating) FILTER (
            WHERE ${reviewTimeAnchor(sql, '')} >= NOW() - make_interval(days => ${priorEndDays})
              AND ${reviewTimeAnchor(sql, '')} < NOW() - make_interval(days => ${windowDays})
          )::float AS star_prior,
          COUNT(star_rating) FILTER (
            WHERE ${reviewTimeAnchor(sql, '')} >= NOW() - make_interval(days => ${priorEndDays})
              AND ${reviewTimeAnchor(sql, '')} < NOW() - make_interval(days => ${windowDays})
          )::int AS star_n_prior
        FROM reviews
        WHERE business_id = ${businessId}
          AND status <> ${REVIEW_STATUS.DELETED}
          AND star_rating IS NOT NULL
          AND ${reviewTimeWindowFilter(sql, '', priorEndDays)}
  `;
```

FILTER predicates compose the anchor directly (the two-sided pairs have no single-sided fragment);
only the outer single-sided WHERE uses `reviewTimeWindowFilter`.

- [ ] **Step 5: Sentiment trend (lines 565, 571, 572)**

```typescript
        LEFT JOIN (
          SELECT DATE_TRUNC('week', ${reviewTimeAnchor(sql, '')})::date AS wk,
                 AVG(sentiment_score) AS avg_score,
                 COUNT(*) AS cnt
          FROM reviews
          WHERE business_id = ${businessId}
            AND status <> ${REVIEW_STATUS.DELETED}
            AND ${reviewTimeAnchor(sql, '')} >= NOW() - make_interval(weeks => ${trendWeeks})
          GROUP BY DATE_TRUNC('week', ${reviewTimeAnchor(sql, '')})
        ) agg ON agg.wk = gs::date
```

- [ ] **Step 6: Update the reputation-batch doc comment**

`fetchReputationRows`'s JSDoc (~line 458) currently says "All scoped by business_id". Add:

```
 * Avg star and the sentiment trend bucket on the Review-time anchor (ADR 0019,
 * #757); response rate stays on detected_at (workflow KPI) and timeSaved keys
 * on approved_at (action timestamp) — neither may be re-anchored.
```

- [ ] **Step 7: DO NOT TOUCH — verify by re-reading before committing**

`rateRows` (lines 480–514, all seven `r.detected_at`), `timeSavedRows` (537–554, `approved_at`),
`ORDER BY rev.detected_at DESC` in recentReviews (line 312), totals, ranking, pending. **Do not
convert any `await` back into a `Promise.all`** — the sequential `settledInOrder` wave and the
sequential reputation batch are #505's fix and their comments say so.

- [ ] **Step 8: Verify**

```bash
cd /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-757-dashboard-review-time-anchor
pnpm vitest run src/lib/dashboard/__tests__ 2>&1 | tail -30
```

Expected: shape tests 10 + 11 PASS; every pre-existing dashboard suite still PASS.

- [ ] **Step 9: Commit**

```bash
git add -A && git commit -m "feat(#757): re-anchor single-location dashboard reputation windows

Velocity, rating breakdown, avg star and sentiment trend compose the
Review-time anchor. Response rate (workflow KPI) and timeSaved (approved_at)
deliberately unchanged — ADR 0019 D2."
```

---

### Task 4: Re-anchor `aggregate-queries.ts` + rename the reviews aliases

**Blocking edges:** T2. **Mutually independent with T3.**

**Files:** Modify `src/lib/dashboard/aggregate-queries.ts`

- [ ] **Step 1: Import the fragments**

```typescript
import { reviewTimeAnchor, reviewTimeWindowFilter } from '@/lib/kpi/fragments';
```

- [ ] **Step 2: Velocity — rename `rv` → `r`, anchor lines 202–203**

```typescript
    () => sql<VelocityRow[]>`
      SELECT b.id AS business_id, gs::date AS week_start, COUNT(r.id)::int AS count
      FROM businesses b
      CROSS JOIN generate_series(
        DATE_TRUNC('week', NOW() - make_interval(weeks => ${velocitySpanWeeks})),
        DATE_TRUNC('week', NOW()),
        INTERVAL '1 week'
      ) gs
      LEFT JOIN reviews r
        ON r.business_id = b.id
        AND r.status <> ${REVIEW_STATUS.DELETED}
        AND ${reviewTimeAnchor(sql, 'r.')} >= NOW() - make_interval(weeks => ${trendWeeks})
        AND DATE_TRUNC('week', ${reviewTimeAnchor(sql, 'r.')})::date = gs::date
      WHERE b.account_id = ${accountId}::uuid
        AND b.archived_at IS NULL
      GROUP BY b.id, gs::date
      ORDER BY b.id, week_start ASC
    `,
```

The anchor stays inside the `LEFT JOIN … ON` clause, so a location with no matching review still
gets its zero-filled row for every week — the per-location zero-fill contract is preserved.

- [ ] **Step 3: Rating breakdown — rename `rev` → `r`, anchor line 218**

```typescript
    () => sql<RatingRow[]>`
      SELECT b.id AS business_id, r.star_rating AS stars, COUNT(*)::int AS count
      FROM businesses b
      JOIN reviews r ON r.business_id = b.id
      WHERE b.account_id = ${accountId}::uuid
        AND b.archived_at IS NULL
        AND r.status <> ${REVIEW_STATUS.DELETED}
        AND r.star_rating IS NOT NULL
        AND ${reviewTimeWindowFilter(sql, 'r.', windowDays)}
      GROUP BY b.id, r.star_rating
    `,
```

The rename keeps the fragment's prefix union at two members — widening it to `'rv.' | 'rev.'` would
force a four-branch switch of near-duplicate SQL in the owner module for no gain (intake decision).

- [ ] **Step 4: Fix the now-stale interface comment**

`PerLocationAggregateSlice.windowedReceived` (line ~59) says "Non-deleted reviews with detected_at
in the window" — still true (it comes from the counter query, which does not move). Leave it, and
add above `reviewVelocity` / `ratingBreakdown` in the same interface:

```typescript
  /** Weekly counts bucketed on the Review-time anchor (ADR 0019, #757). */
  reviewVelocity: DashboardDataActive['reviewVelocity'];
  /** 1–5★ distribution over the Review-time-anchored window (ADR 0019, #757). */
  ratingBreakdown: RatingBreakdown;
```

- [ ] **Step 5: DO NOT TOUCH** — the counter query (lines 156–184, `r.detected_at` at 168 and 171
feeds the account response rate), ranking, briefs, pending counts, the baseline anchor read, or the
`settledInOrder` sequencing.

- [ ] **Step 6: Verify**

```bash
cd /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-757-dashboard-review-time-anchor
pnpm vitest run src/lib/dashboard/__tests__ 2>&1 | tail -30
pnpm ci:tenant-scope 2>&1 | tail -20
```

Expected: shape tests 12 + 13 PASS; `aggregate-queries.test.ts` still PASS; **`ci:tenant-scope`
clean** — this is the audit the alias rename could disturb, so it runs here rather than waiting for
the gate.

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "feat(#757): re-anchor aggregate velocity + rating breakdown

Renames the reviews aliases rv/rev to r so the fragment's '' | 'r.' prefix
union covers both sites. Counter query (account response rate) untouched."
```

---

### Task 5: Delete Stack A

**Blocking edges:** T3 and T4 — Stack B must already carry the anchor so every intermediate commit
is shippable.

**Files:**
- Delete: `src/lib/kpi/service.ts`, `src/lib/kpi/__tests__/service.test.ts`, `src/lib/kpi/__tests__/service.cache.test.ts`
- Delete: `src/app/api/dashboard/kpis/route.ts`, `src/app/api/dashboard/kpis/__tests__/route.test.ts`
- Modify: `src/lib/kpi/types.ts`, `scripts/ci/__tests__/db-imports-audit.test.ts`

- [ ] **Step 1: Delete the files**

```bash
cd /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-757-dashboard-review-time-anchor
git rm src/lib/kpi/service.ts src/lib/kpi/__tests__/service.test.ts \
       src/lib/kpi/__tests__/service.cache.test.ts
git rm -r src/app/api/dashboard/kpis
```

- [ ] **Step 2: Drop the orphaned exports from `src/lib/kpi/types.ts`**

Remove `KpiResponseRate`, `KpiReviewVolume`, `SentimentTrendPoint`, `KpiScope` and
`DashboardKpiSummary` (lines 5–53) — verified zero importers once Stack A is gone. **Keep**
`DASHBOARD_WINDOWS`, `DashboardWindow`, `DEFAULT_DASHBOARD_WINDOW`, `DashboardWindowParams`,
`WINDOW_PARAMS`, `resolveDashboardWindow`, `dashboardWindowParams` — 9 importers. Replace the file
header:

```typescript
// Canonical analytics window vocabulary for the dashboard payload. Formerly
// also held the Spec-11 launch KPI summary types; those died with the
// consumer-less Stack A KPI service (#757, Pathfinder P1). The Review-time
// anchor fragments live beside this file in ./fragments.ts.
```

- [ ] **Step 3: Fix the stale route path in the CI audit test**

`scripts/ci/__tests__/db-imports-audit.test.ts:102` asserts composition-root status for the deleted
route. It is a pure string test so it would keep passing while pointing at nothing. Repoint it at a
live route:

```typescript
    expect(isCompositionRoot('src/app/api/dashboard/route.ts', REGISTERED_WORKER_ROOTS)).toBe(true);
```

- [ ] **Step 4: Prove nothing references the deleted surface**

```bash
cd /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-757-dashboard-review-time-anchor
rg -n "kpi/service|getLocationKpiSummary|getAccountKpiSummary|DashboardKpiSummary|KpiScope" \
   src worker scripts e2e || echo "CLEAN"
rg -n "api/dashboard/kpis" src worker scripts e2e || echo "CLEAN"
pnpm typecheck 2>&1 | tail -10
```

Expected: `CLEAN` for both greps, typecheck passes. Historical records
(`docs/reviews/**/blast-radius.md`, the superseded root `PLAN.md`) keep their references by design —
they are a log, not a live cross-reference.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "refactor(#757): delete the consumer-less Stack A KPI service and route

getLocationKpiSummary + getAccountKpiSummary + GET /api/dashboard/kpis had zero
consumers (verified three ways, Pathfinder P1). The anchor semantics survive in
kpi/fragments.ts, ADR 0019 and the eval suite. Window vocabulary kept."
```

---

### Task 6: Documentation

**Blocking edges:** T5.

**Files:** Modify `docs/adr/0019-kpi-review-time-anchor.md`, `CONTEXT.md`, `.claude/CLAUDE.md`, `docs/directory.md`

- [ ] **Step 1: ADR 0019 addendum**

Append:

```markdown
## Addendum — 2026-08-11 (#757): one stack, one fragment owner

#688 applied this ADR to `src/lib/kpi/service.ts`, which nothing rendered. The
customer-visible dashboard reads `src/lib/dashboard/service.ts` +
`aggregate-queries.ts`, which still bucketed on `detected_at` — so a consented
Review import produced exactly the spike this ADR removes, on the only surfaces
owners see. #757 closes that gap (Pathfinder 2026-08-10 P1):

- The anchor fragments moved to **`src/lib/kpi/fragments.ts`**, now their single
  owner. `reviewTimeAnchor` and `reviewTimeWindowFilter` are the only exports —
  `detectedAtWindowFilter` and the TTR validity filter had no surviving composer
  and died with Stack A rather than shipping as unused abstraction.
- The rendered stack composes them for **velocity, rating breakdown, avg star and
  the sentiment trend**, per-location and per-account. Response rate and the
  aggregate review counters stay on `detected_at` (Decision 2); timeSaved keys on
  `approved_at`; the recent-review feed keeps ordering on `detected_at`
  (ingestion recency).
- `getLocationKpiSummary`, `getAccountKpiSummary` and `GET /api/dashboard/kpis`
  were **deleted** — zero consumers. Their calendar-month volume MoM and TTR
  duration metrics have never rendered anywhere; when the deferred KPI-cards work
  ships it extends the dashboard payload composing the same fragments.
- Decision 3 (the TTR validity filter) is **recorded but no longer implemented in
  code**: the dashboard payload has no duration metric to filter. It returns with
  the metric.

**Deferred, recorded here so it is not rediscovered as a surprise:**
`LEAST(review_date, detected_at) >= …` is not sargable on either single-column
index, so these reads fall back to the `business_id` index and filter. At the
#474 Capacity target (250 locations, ~125 reviews/day) per-business row counts
are small and both stacks already accepted this since #688. Revisit with an
expression index only if dashboard read latency regresses — that is a migration,
and this ADR's no-migration property is deliberate.
```

- [ ] **Step 2: `CONTEXT.md` — Review-time anchor entry**

Change `One owner: `reviewTimeAnchor` (`src/lib/kpi/service.ts`).` to:

```
One owner: `reviewTimeAnchor` (`src/lib/kpi/fragments.ts`), composed by the rendered dashboard payload — per-location and per-account velocity, rating breakdown, avg star and sentiment trend (#757).
```

- [ ] **Step 3: `.claude/CLAUDE.md` — Customer KPIs bullet**

Replace the bullet (Database section) with:

```markdown
- **Customer KPIs**: the dashboard payload (`src/lib/dashboard/*`) is the ONE KPI stack — per-location `getActiveDashboardData` and per-account `fetchPerLocationAggregateSlices`, served by `GET /api/dashboard`. Reputation metrics (velocity, rating breakdown, avg star, sentiment trend) bucket on the **Review-time anchor** `LEAST(review_date, detected_at)` via the single-owner fragments in `src/lib/kpi/fragments.ts` (#688/#757, ADR 0019); response rate and the aggregate review counters stay on `detected_at` (workflow KPIs), timeSaved keys on `approved_at`, and the recent-review feed orders on `detected_at`. `src/lib/kpi/` now holds only the window vocabulary (`types.ts`) and those fragments — the consumer-less `getLocationKpiSummary`/`getAccountKpiSummary` + `GET /api/dashboard/kpis` were deleted in #757.
```

- [ ] **Step 4: `docs/directory.md`**

Update the `src/lib/kpi/` entry to `types.ts` + `fragments.ts` (no service), and remove the
`src/app/api/dashboard/kpis/` route row.

- [ ] **Step 5: Verify and commit**

```bash
cd /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-757-dashboard-review-time-anchor
rg -n "kpi/service" docs/directory.md CONTEXT.md .claude/CLAUDE.md || echo "CLEAN"
git add -A && git commit -m "docs(#757): ADR 0019 addendum, CONTEXT.md owner path, CLAUDE.md KPI stack, directory"
```

---

## Out of scope (intake non-goals — reject in review if they appear)

Re-anchoring response rate / the aggregate counters / the MonthlyImpactWorker digest · re-anchoring
timeSaved or the recent-review feed · preserving Stack A's volume MoM or TTR duration metrics ·
extracting `detectedAtWindowFilter` or a TTR validity fragment · an expression index or any
migration · the null-vs-0 empty-state divergence · editing historical `docs/reviews/**` or root
`PLAN.md` · reintroducing any concurrent `Promise.all` fan-out on the shared pool.

## Self-review

- **Spec coverage** — #757 task 1 (re-anchor reputation windows) → T3+T4; task 2 (adjudicate the
  consumer-less route) → T5, deleted; task 3 (extend the TTR validity filter to any dashboard
  duration metric) → none exists, recorded in the ADR addendum step 1.
- **Placeholders** — none: every step carries the literal SQL/TypeScript it changes.
- **Type consistency** — `reviewTimeAnchor(sql, prefix)` / `reviewTimeWindowFilter(sql, prefix,
  windowDays)` signatures are identical in T2, T3 and T4; `ReviewsPrefix` is `'' | 'r.'` everywhere
  and T4's rename is what keeps that true.
