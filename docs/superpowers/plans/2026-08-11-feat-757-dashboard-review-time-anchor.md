# #757 — Review-time anchor on the dashboard-payload aggregates

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development to implement
> this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Revision 3** — incorporates codex plan-review round 1 (3 BLOCKER / 16 MAJOR / 4 MINOR; 22
> accepted, 1 partially rejected) and round 2 verification-only (19 FIXED, 1 NOT FIXED, 6 fixes
> that introduced defects — all seven corrected here). Triage verdicts: the two "Review appendix"
> sections at the bottom.

**Goal:** Bucket the reputation-flavored windows of the *rendered* dashboard payload on the
**Review-time anchor** `LEAST(review_date, detected_at)` (ADR 0019), make `src/lib/kpi/fragments.ts`
the single owner of that spelling, and delete the consumer-less Stack A KPI service +
`GET /api/dashboard/kpis`.

**Architecture:** #688 shipped the anchor into `src/lib/kpi/service.ts` ("Stack A"), which nothing
renders. The dashboard owners actually see ("Stack B") is `src/lib/dashboard/service.ts` +
`aggregate-queries.ts`, still on `detected_at`. This plan moves the two anchor fragments into a
module both stacks can import, composes them at 17 plug sites in Stack B, then deletes Stack A
whole. No migration, no new index, no interface change on any surviving function.

**Tech Stack:** Postgres.js lazy fragments, vitest (`worker/__tests__/helpers/mock-sql.ts` harness
for SQL-shape pins, `describeWithDb` + `assertSchemaReady` for the live-DB eval suite), Next.js
route deletion.

**Decisions of record:** ADR 0019 (`docs/adr/0019-kpi-review-time-anchor.md`) ·
`docs/reviews/PATHFINDER-2026-08-10/03-unified-proposal.md` P1 (**see the superseding adjudication
below**) · issue #757 · intake `docs/superpowers/plans/feat-757-dashboard-review-time-anchor-intake.json`

### Superseding adjudication vs Pathfinder P1 (owner-approved 2026-08-11)

P1 item 1 required extracting **four** fragments (`reviewTimeAnchor`, `reviewTimeWindowFilter`,
`detectedAtWindowFilter`, the TTR validity filter). This plan extracts **two**. Reason: once Stack A
is deleted, `detectedAtWindowFilter` and the TTR validity filter have **zero composers** — Stack B's
response rate stays literal per ADR 0019 D2 (P1 itself forbids touching it) and Stack B has no
duration metric to validity-filter. Shipping two exports with no callers is dead abstraction, and
`fallow` would flag them. P1 item 1 is superseded on this point only; items 2–6 are implemented as
written. The ADR 0019 addendum (Task 6) records this.

P1 also preferred *widening* the fragment prefix union over renaming Stack B's aliases; it left that
to the implementer. This plan renames (`rv`/`rev` → `r`) — widening to four members forces a
four-branch switch of near-duplicate SQL in the owner module for no gain.

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
| `src/lib/kpi/types.ts` | **Narrows** (5 orphan exports removed) | The window vocabulary keeps every one of its importers. |

**Anti-slop guard to carry into the module doc comment:** nothing varies across this seam. Do NOT
later add an "anchor strategy" / registry / injected-clock abstraction behind it. Two exports, one
spelling, many composers — and Task 1's single-owner test enforces exactly that.

## File structure

**Create**
- `src/lib/kpi/fragments.ts` — anchor fragment owner
- `src/lib/kpi/__tests__/fragments.test.ts` — fragment unit pins + single-owner source audit
- `src/lib/dashboard/__tests__/review-time-anchor.integration.test.ts` — live-DB eval suite (moved + re-pointed from `src/lib/kpi/__tests__/service.anchor.integration.test.ts`)
- `src/lib/dashboard/__tests__/service.review-time-anchor.test.ts` — SQL-shape pins, single-location
- `src/lib/dashboard/__tests__/aggregate-queries.review-time-anchor.test.ts` — SQL-shape pins, aggregate

**Modify**
- `src/lib/dashboard/service.ts` — 14 plug lines
- `src/lib/dashboard/aggregate-queries.ts` — 3 plug lines + `rv`/`rev` → `r` rename
- `src/lib/kpi/types.ts` — drop 5 orphan exports
- `scripts/ci/tenant-scope-allowlist.ts` — drop 7 entries, baseline 408 → 401
- `scripts/ci/__tests__/db-imports-audit.test.ts` — lines 102 **and** 118
- `docs/adr/0019-kpi-review-time-anchor.md`, `CONTEXT.md`, `.claude/CLAUDE.md`, `docs/directory.md`

**Delete**
- `src/lib/kpi/service.ts`, `src/lib/kpi/__tests__/service.test.ts`, `src/lib/kpi/__tests__/service.cache.test.ts`
- `src/app/api/dashboard/kpis/route.ts`, `src/app/api/dashboard/kpis/__tests__/route.test.ts`

## Task graph

```
T1 (eval) ─→ T2 (fragments) ─┬─→ T3 (service.ts plugs) ─┐
                             └─→ T4 (aggregate plugs) ───┴─→ T4.5 (integration checkpoint)
                                                              └─→ T5 (delete Stack A) ─→ T6 (docs) ─→ T7 (staging smoke)
```

**T3 and T4 are mutually independent** — no blocking edge between them, and their *edited* file sets
are disjoint (T3 edits only `service.ts`; T4 edits only `aggregate-queries.ts`; every test file is
authored in T1 and edited by neither). Eligible for parallel dispatch after T1's enforcement spot
check.

**Red-branch reality (do not claim otherwise):** T1 and T2 deliberately commit a red branch — that
is what eval-first means. `review-time-anchor.integration.test.ts` is a *shared* suite covering both
T3's and T4's metrics, so it stays partly red until **both** land. Therefore:

- T3 and T4 each verify with **only their own suites**, enumerated explicitly in their steps.
- **Neither T3 nor T4 ever runs the shared live-DB suite.** It has exactly one owner: **T4.5**, a
  checkpoint task that depends on both. This is deliberate — an earlier draft said "T4's final step"
  and "whichever finishes second", which leaves the run unowned if T3 finishes second.
- The branch is first fully green at the end of T4.5. Do not let a subagent "fix" a red test that
  belongs to the other task.

---

### Task 1: Eval — author every promised test as a failing spec

**Files:**
- Create: `src/lib/dashboard/__tests__/review-time-anchor.integration.test.ts`
- Create: `src/lib/dashboard/__tests__/service.review-time-anchor.test.ts`
- Create: `src/lib/dashboard/__tests__/aggregate-queries.review-time-anchor.test.ts`
- Create: `src/lib/kpi/__tests__/fragments.test.ts`
- Delete: `src/lib/kpi/__tests__/service.anchor.integration.test.ts` (its scaffolding moves)

- [ ] **Step 1: Move the live-DB suite and re-point it at the rendered stack**

```bash
cd /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-757-dashboard-review-time-anchor
git mv src/lib/kpi/__tests__/service.anchor.integration.test.ts \
       src/lib/dashboard/__tests__/review-time-anchor.integration.test.ts
```

**Port from the moved file** (it encodes hard-won live-DB conventions): the `vi.mock('@/lib/db/redis-cache', …)`
always-miss stub, `POSTED`, `testDatabaseUrl`, `sql()`, `SeedReviewSpec`, `seedReview`,
`seedPostedResponse`, `assertSchemaReady(db, [MIGRATION_071_RUN_SPINE])`, and the `afterAll`
FK-ordered cleanup loop. **Rewrite, do not port, the header prose** — it names Stack A, the deleted
`service.test.ts`, and a "mock suite is the every-day backstop" claim that is no longer accurate.
Keep the live-DB convention paragraph and the calendar-boundary timing-risk paragraph; replace the
Stack-A specifics with:

```
// EVAL suite for #757 — the Review-time anchor on the RENDERED dashboard stack
// (getActiveDashboardData + fetchPerLocationAggregateSlices). #688 proved these
// semantics against Stack A, which nothing renders; this proves them where owners
// actually read them. The mocked suites
// (service.review-time-anchor.test.ts / aggregate-queries.review-time-anchor.test.ts)
// pin the SQL SPELLING every day; this suite proves the bucketing MEANS what
// ADR 0019 decided, against real Postgres.
```

**CRITICAL — week-bucket assertions must not use `::text`.** postgres.js decodes a `date` column
into a JS `Date`, and both `mapReviewVelocity` and `buildReputationSummary` stringify it with
`String(...)`, which yields the long local form (`"Mon Aug 10 2026 00:00:00 GMT-0700…"`). A
`::text` expectation (`'2026-08-10'`) can never match. Select expected weeks as `::date` and run
them through the **same** `String(...)` path — this is exactly what the moved suite's own comment at
its trend test documents.

```typescript
import { getActiveDashboardData } from '../service';
import { fetchPerLocationAggregateSlices } from '../aggregate-queries';

const VELOCITY_BIZ = randomUUID();  // t1  velocity week bucketing
const TREND_BIZ = randomUUID();     // t2  sentiment-trend week bucketing
const STAR_BIZ = randomUUID();      // t3 + t10  avg-star current & prior windows
const RATING_BIZ = randomUUID();    // t4  rating-breakdown window
const NULLFB_BIZ = randomUUID();    // t5  NULL review_date fallback
const FUTURE_BIZ = randomUUID();    // t6  future review_date clamp
const RATE_BIZ = randomUUID();      // t7  response-rate detected_at pin (negative control)
const FEED_BIZ = randomUUID();      // t8  recent-review feed detected_at pin (negative control)
const TIMESAVED_BIZ = randomUUID(); // t11 timeSaved approved_at pin (negative control)
const AGG_BIZ = randomUUID();       // t9 + t12  aggregate anchor + counter negative control
const EMPTY_BIZ = randomUUID();     // t13 aggregate zero-fill
const ALL_BIZ = [VELOCITY_BIZ, TREND_BIZ, STAR_BIZ, RATING_BIZ, NULLFB_BIZ, FUTURE_BIZ,
                 RATE_BIZ, FEED_BIZ, TIMESAVED_BIZ, AGG_BIZ, EMPTY_BIZ] as const;

// seedLocation: businesses_account_primary_uniq permits ONE primary per account.
isPrimary: bizId === VELOCITY_BIZ,

/** Reputation metrics are opt-in; every assertion below needs the batch. */
async function rep(bizId: string) {
  return getActiveDashboardData(sql(), bizId, { includeReputationMetrics: true });
}

/**
 * Expected week starts, selected as ::date and stringified through the SAME
 * postgres.js decode + String() path the mappers use. NEVER ::text.
 */
async function weekMarkers() {
  const [row] = await sql()<{ current_week: unknown; back3: unknown; back6: unknown }[]>`
    SELECT DATE_TRUNC('week', NOW())::date AS current_week,
           (DATE_TRUNC('week', NOW()) - interval '21 days')::date AS back3,
           (DATE_TRUNC('week', NOW()) - interval '42 days')::date AS back6
  `;
  return {
    currentWeek: String(row!.current_week),
    back3: String(row!.back3),
    back6: String(row!.back6),
  };
}
```

Fixtures — **all time arithmetic in SQL**, never a JS `Date`:

```typescript
// t1 — imported review written three weeks back (Monday-aligned), stored today.
await seedReview(VELOCITY_BIZ, { star: 4,
  reviewDate: sql()`DATE_TRUNC('week', NOW()) - interval '21 days'`, detectedAt: sql()`NOW()` });

// t2 — same shape plus a sentiment score so the trend has a value.
await seedReview(TREND_BIZ, { star: 4, sentimentScore: 0.8,
  reviewDate: sql()`DATE_TRUNC('week', NOW()) - interval '21 days'`, detectedAt: sql()`NOW()` });

// t3 + t10 — a 1★ import 45 days back (OUTSIDE the 30d current window, INSIDE the
// 60d prior window) beside an organic in-window 5★. Anchored: current 5 from one
// sample, prior 1 from one sample, delta +4. On detected_at both land in current
// (avg 3) and prior is empty (delta suppressed) — so this one fixture pins the
// current window, the prior window, star_n_prior AND the delta.
await seedReview(STAR_BIZ, { star: 1,
  reviewDate: sql()`NOW() - interval '45 days'`, detectedAt: sql()`NOW()` });
await seedReview(STAR_BIZ, { star: 5,
  reviewDate: sql()`NOW() - interval '1 day'`, detectedAt: sql()`NOW() - interval '1 day'` });

// t4 — same shape for the rating breakdown (60 days back: outside the 30d window).
await seedReview(RATING_BIZ, { star: 1,
  reviewDate: sql()`NOW() - interval '60 days'`, detectedAt: sql()`NOW()` });
await seedReview(RATING_BIZ, { star: 5,
  reviewDate: sql()`NOW() - interval '1 day'`, detectedAt: sql()`NOW() - interval '1 day'` });

// t5 — no review_date at all: LEAST ignores NULLs, anchor falls back to detected_at.
await seedReview(NULLFB_BIZ, { star: 4, sentimentScore: 0.4,
  reviewDate: null, detectedAt: sql()`NOW()` });

// t6 — provider clock skew. +8 days (NOT +2) guarantees a LATER ISO week EVERY day
// of the week, so a naive COALESCE(review_date, detected_at) lands in a week
// generate_series never emits and the row vanishes — failing live, every day.
await seedReview(FUTURE_BIZ, { star: 3, sentimentScore: 0.5,
  reviewDate: sql()`DATE_TRUNC('week', NOW()) + interval '8 days'`, detectedAt: sql()`NOW()` });

// t7 — imported UNANSWERED review (current window) + an answered one in the PRIOR
// window, so the prior rate and its sample size are pinned too.
await seedReview(RATE_BIZ, { star: 2,
  reviewDate: sql()`NOW() - interval '200 days'`, detectedAt: sql()`NOW()` });
const ratePrior = await seedReview(RATE_BIZ, { star: 5,
  reviewDate: sql()`NOW() - interval '45 days'`, detectedAt: sql()`NOW() - interval '45 days'` });
await seedPostedResponse(ratePrior, RATE_BIZ, sql()`NOW() - interval '44 days'`);

// t8 — imported review (ancient review_date, detected today) beside an older-detected organic one.
await seedReview(FEED_BIZ, { star: 2,
  reviewDate: sql()`NOW() - interval '200 days'`, detectedAt: sql()`NOW()` });
await seedReview(FEED_BIZ, { star: 5,
  reviewDate: sql()`NOW() - interval '2 days'`, detectedAt: sql()`NOW() - interval '2 days'` });

// t11 — ancient imported review answered TODAY. timeSaved keys on approved_at, so
// it counts in the current window no matter what the anchor says.
const tsReview = await seedReview(TIMESAVED_BIZ, { star: 3,
  reviewDate: sql()`NOW() - interval '300 days'`, detectedAt: sql()`NOW()` });
await seedPostedResponse(tsReview, TIMESAVED_BIZ, sql()`NOW() - interval '1 hour'`);

// t9 + t12 — aggregate: one import SIX weeks back (inside the 8-week velocity
// series, OUTSIDE the 30d rating window) answered today, plus one organic this week.
const aggImport = await seedReview(AGG_BIZ, { star: 1,
  reviewDate: sql()`DATE_TRUNC('week', NOW()) - interval '42 days'`, detectedAt: sql()`NOW()` });
await seedPostedResponse(aggImport, AGG_BIZ, sql()`NOW() - interval '1 hour'`);
// NOW() for BOTH timestamps, not NOW() - interval '1 day': this fixture asserts a
// CURRENT-WEEK bucket, and on a Monday run a 1-day-old row belongs to the prior
// ISO week. Any fixture whose assertion names a week must be seeded at NOW().
await seedReview(AGG_BIZ, { star: 5,
  reviewDate: sql()`NOW()`, detectedAt: sql()`NOW()` });

// t13 — EMPTY_BIZ gets no reviews at all (zero-fill contract).
```

Tests — titles **verbatim**, `promised-tests` matches them exactly:

```typescript
it('velocity buckets an imported review into its review_date week, not the import week', async () => {
  const { currentWeek, back3 } = await weekMarkers();
  const data = await rep(VELOCITY_BIZ);
  const at = (wk: string) => data.reviewVelocity.find((p) => p.weekStart === wk);
  expect(at(back3)?.count).toBe(1);
  expect(at(currentWeek)?.count).toBe(0);
  // Exactly one row in the whole series — an OR that kept import-time membership
  // would double-count it and still satisfy the two assertions above.
  expect(data.reviewVelocity.reduce((n, p) => n + p.count, 0)).toBe(1);
});

it('sentiment trend buckets an imported review into its review_date week, not the import week', async () => {
  const { currentWeek, back3 } = await weekMarkers();
  const data = await rep(TREND_BIZ);
  const at = (wk: string) => data.reputationSummary!.trend.find((p) => p.weekStart === wk);
  expect(at(back3)?.reviewCount).toBe(1);
  expect(at(currentWeek)?.reviewCount).toBe(0);
  expect(data.reputationSummary!.trend.reduce((n, p) => n + p.reviewCount, 0)).toBe(1);
});

it('avg star window excludes a review whose review_date is outside the window even though detected_at is inside', async () => {
  const data = await rep(STAR_BIZ);
  // Anchored: only the organic 5★ is in the 30d current window.
  // On detected_at both are in-window and this reads 3.
  expect(data.reputationSummary!.averageStar.current).toBe(5);
});

it('avg star prior window and sample size bucket on the review-time anchor', async () => {
  const data = await rep(STAR_BIZ);
  const star = data.reputationSummary!.averageStar;
  // The 45-day-old import belongs to the PRIOR window (30–60d) by review time.
  // On detected_at it sits in the current window and the prior sample is empty,
  // which would suppress the delta entirely (buildMetric, reputation-summary.ts).
  expect(star.priorSampleSize).toBe(1);
  expect(star.delta).toBe(4);
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
  const { currentWeek } = await weekMarkers();
  const data = await rep(FUTURE_BIZ);
  // NOT a red-before/green-after test: detected_at bucketing already puts this
  // row in the current week, so it passes before and after. Its job is to fail
  // if anyone swaps LEAST for COALESCE — under COALESCE the +8d review_date
  // lands in a week generate_series never emits and the row disappears.
  expect(data.reviewVelocity.find((p) => p.weekStart === currentWeek)?.count).toBe(1);
  expect(data.reputationSummary!.trend.find((p) => p.weekStart === currentWeek)?.reviewCount).toBe(1);
  expect(data.reviewVelocity.reduce((n, p) => n + p.count, 0)).toBe(1);
  expect(data.reputationSummary!.trend.reduce((n, p) => n + p.reviewCount, 0)).toBe(1);
});

it('response rate still windows on detected_at so imported unanswered reviews drag the rate', async () => {
  const data = await rep(RATE_BIZ);
  const rate = data.reputationSummary!.responseRate;
  // NEGATIVE CONTROL — green before and after. Workflow KPI, ADR 0019 D2: the
  // import counts as received today and drags the current rate to 0%.
  expect(rate.current).toBe(0);
  // The prior window is pinned too: re-anchoring it would move the 45-day-old
  // answered review out of prior and silently empty the sample.
  expect(rate.priorSampleSize).toBe(1);
  expect(rate.delta).toBe(-100);
});

it('recent-review feed still orders on detected_at so an imported review surfaces by ingestion recency', async () => {
  const data = await rep(FEED_BIZ);
  // NEGATIVE CONTROL — the feed is ingestion recency, not review time.
  expect(data.recentReviews[0]?.starRating).toBe(2);
});

it('time-saved keys on approved_at so an imported review answered today still counts', async () => {
  const data = await rep(TIMESAVED_BIZ);
  // NEGATIVE CONTROL — action timestamp, never anchored. One handled response
  // × MINUTES_SAVED_PER_RESPONSE (7, dashboard/constants.ts).
  expect(data.reputationSummary!.timeSavedMinutes.current).toBe(7);
});

it('aggregate slices apply the same review-time anchor to velocity and rating breakdown', async () => {
  const { currentWeek, back6 } = await weekMarkers();
  const slices = await fetchPerLocationAggregateSlices(sql(), tenant!.accountId, '30d');
  const slice = slices.get(AGG_BIZ)!;
  expect(slice.reviewVelocity.find((p) => p.weekStart === back6)?.count).toBe(1);
  expect(slice.reviewVelocity.find((p) => p.weekStart === currentWeek)?.count).toBe(1);
  expect(slice.reviewVelocity.reduce((n, p) => n + p.count, 0)).toBe(2);
  // 42 days back is outside the 30d rating window: only the organic 5★ counts.
  expect(slice.ratingBreakdown.total).toBe(1);
  expect(slice.ratingBreakdown.counts.find((c) => c.stars === 5)?.count).toBe(1);
});

it('aggregate windowedReceived and windowedResponded still count on detected_at', async () => {
  const slices = await fetchPerLocationAggregateSlices(sql(), tenant!.accountId, '30d');
  const slice = slices.get(AGG_BIZ)!;
  // NEGATIVE CONTROL — these feed the account response rate (workflow KPI).
  // Both reviews were detected inside 30d; the import is answered, the organic is not.
  expect(slice.windowedReceived).toBe(2);
  expect(slice.windowedResponded).toBe(1);
});

it('a location with no reviews still gets a zero-filled velocity series in the aggregate slice', async () => {
  const slices = await fetchPerLocationAggregateSlices(sql(), tenant!.accountId, '30d');
  const slice = slices.get(EMPTY_BIZ)!;
  // The anchor must stay in the LEFT JOIN ... ON clause. Moved into WHERE it
  // becomes an inner join and this location loses its series entirely.
  expect(slice.reviewVelocity).toHaveLength(8);
  expect(slice.reviewVelocity.every((p) => p.count === 0)).toBe(true);
});
```

- [ ] **Step 2: Author the single-location SQL-shape pins**

`src/lib/dashboard/__tests__/service.review-time-anchor.test.ts` — follow
`service.rating-breakdown.test.ts` (same harness, same Redis stub, same seed pattern). The
`createMockSql` harness flattens nested fragments into `call.text`, so a composed fragment is
visible as literal SQL; `sqlCalls` records on `await` only.

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
const ANCHOR = 'LEAST(review_date, detected_at)';

// Sequential settledInOrder order: 0 business, 1 totalReviews, 2 totalResponded,
// 3 velocity, 4 ranking, 5 recentReviews, 6 monthlyBrief, 7 weeklyBrief,
// 8 zernioConn, 9 queuedReconnect, 10 unresolvedIncident, 11 ratingBreakdown,
// (readPendingMarker is Redis — it does NOT consume the queue), then the
// reputation batch: 12 rate, 13 star, 14 timeSaved, 15 trend, 16 pendingCount.
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

/**
 * Find by a marker that must match EXACTLY ONE query in the wave. Throwing on an
 * ambiguous marker is the point: a plain `.find()` silently returns the first
 * match, which is how an earlier draft asserted timeSaved's properties against
 * the response-rate query and would have passed forever.
 */
function findOnly(needle: string): string {
  const hits = harness.sqlCalls.filter((c) => c.text.includes(needle));
  if (hits.length !== 1) {
    throw new Error(`marker ${JSON.stringify(needle)} matched ${hits.length} queries, expected 1`);
  }
  return hits[0]!.text;
}
const find = findOnly;
const countAnchors = (text: string) => text.split(ANCHOR).length - 1;
/** Blank out the approved anchor so any REMAINING detected_at is a bare one. */
const stripAnchor = (text: string) => text.split(ANCHOR).join('«anchor»');

describe('getActiveDashboardData — Review-time anchor (#757, ADR 0019)', () => {
  beforeEach(() => {
    harness = createMockSql();
    mockSql = harness.mockSql as unknown as Sql;
  });

  it('velocity, avg star, sentiment trend and rating breakdown queries all spell LEAST(review_date, detected_at)', async () => {
    seed();
    await getActiveDashboardData(mockSql, BUSINESS_ID, { includeReputationMetrics: true });
    const queries = {
      velocity: find('COALESCE(r.cnt, 0)'),
      star: find('star_n_current'),
      trend: find('AVG(sentiment_score)'),
      rating: find('GROUP BY star_rating'),
    };
    // Exact occurrence counts — a partially re-anchored query (say, the FILTER
    // predicates moved but the outer WHERE left behind) passes a bare
    // `toContain` and fails here.
    const expected = { velocity: 3, star: 7, trend: 3, rating: 1 };
    for (const [name, text] of Object.entries(queries)) {
      expect(countAnchors(text), `${name} anchor occurrences`).toBe(
        expected[name as keyof typeof expected],
      );
      // Nothing but the anchor may reference detected_at in these four queries.
      expect(stripAnchor(text), `${name} must have no bare detected_at`).not.toContain('detected_at');
    }
  });

  it('response-rate and timeSaved queries never spell LEAST(', async () => {
    seed();
    await getActiveDashboardData(mockSql, BUSINESS_ID, { includeReputationMetrics: true });
    // NEGATIVE CONTROL. `handled_prior` appears in BOTH the rate and timeSaved
    // queries, and `FROM responses resp` appears THREE times (twice inside the
    // rate query's EXISTS subqueries, service.ts:488,502, before timeSaved's own
    // at :546) — so timeSaved is selected by the one marker unique to it, and
    // findOnly throws if that ever stops being true.
    const rate = find('received_current');
    const timeSaved = find('JOIN reviews r ON r.id = resp.review_id');
    expect(timeSaved).toContain('handled_prior');
    expect(rate).not.toContain('LEAST(');
    expect(timeSaved).not.toContain('LEAST(');
    expect(rate).toContain('r.detected_at >= NOW()');
    expect(timeSaved).toContain('resp.approved_at >= NOW()');
  });
});
```

- [ ] **Step 3: Author the aggregate SQL-shape pins**

`src/lib/dashboard/__tests__/aggregate-queries.review-time-anchor.test.ts` — model the seed on the
existing `aggregate-queries.test.ts` wave (0 baseline, 1 counters, 2 velocity, 3 rating, 4 ranking,
5 monthly, 6 weekly, 7 pending).

```typescript
const ANCHOR = 'LEAST(r.review_date, r.detected_at)';
const countAnchors = (t: string) => t.split(ANCHOR).length - 1;
const stripAnchor = (t: string) => t.split(ANCHOR).join('«anchor»');
// Same throw-on-ambiguous-marker helper as the single-location suite — copy it
// verbatim; a plain .find() silently returns the first of several matches.
function find(needle: string): string {
  const hits = harness.sqlCalls.filter((c) => c.text.includes(needle));
  if (hits.length !== 1) {
    throw new Error(`marker ${JSON.stringify(needle)} matched ${hits.length} queries, expected 1`);
  }
  return hits[0]!.text;
}

it('aggregate velocity and rating-breakdown queries spell LEAST(r.review_date, r.detected_at)', async () => {
  seed();
  await fetchPerLocationAggregateSlices(mockSql, ACCOUNT_ID, '30d');
  const velocity = find('CROSS JOIN generate_series');
  const rating = find('GROUP BY b.id, r.star_rating');
  expect(countAnchors(velocity)).toBe(2);
  expect(countAnchors(rating)).toBe(1);
  expect(stripAnchor(velocity)).not.toContain('detected_at');
  expect(stripAnchor(rating)).not.toContain('detected_at');
  // Aliases renamed to r. so the fragment's '' | 'r.' union covers both sites.
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

- [ ] **Step 4: Author the fragment pins + the single-owner audit**

`src/lib/kpi/__tests__/fragments.test.ts`. The first two are `.todo` here because the module does
not exist yet; **T2 converts them**. A surviving `.todo` satisfies the `promised-tests` gate while
proving nothing — treat one as a review-blocking defect. The third is real immediately: it is the
test that stops Stack B hand-spelling `LEAST(...)` and leaving `fragments.ts` unused, which every
other test in this plan would happily allow.

```typescript
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const OWNER = join('src', 'lib', 'kpi', 'fragments.ts');
const ANCHOR_PATTERN = /LEAST\(\s*(?:[A-Za-z_][\w$]*\.)?review_date\s*,/;

function sourceFiles(root: string): string[] {
  return readdirSync(root, { recursive: true, encoding: 'utf8' })
    .filter((p) => /\.tsx?$/.test(p) && !p.includes('__tests__'))
    .map((p) => join(root, p));
}

describe('kpi/fragments — Review-time anchor owner (#757)', () => {
  it.todo('reviewTimeAnchor emits the unprefixed and r.-prefixed spellings and nothing else');
  it.todo('reviewTimeWindowFilter binds the window as an integer parameter, never interpolated text');

  it('the Review-time anchor is spelled only in kpi/fragments.ts', () => {
    const offenders = [...sourceFiles('src'), ...sourceFiles('worker')]
      .filter((f) => f !== OWNER && ANCHOR_PATTERN.test(readFileSync(f, 'utf8')));
    // Every composer must go through the fragment. A hand-spelled LEAST in
    // dashboard/service.ts would satisfy the live-DB suite AND the shape pins
    // while leaving fragments.ts dead — this is the only test that catches it.
    expect(offenders).toEqual([]);
  });
});
```

- [ ] **Step 5: Run the eval suite and confirm the expected RED/GREEN split**

```bash
cd /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-757-dashboard-review-time-anchor
pnpm vitest run src/lib/dashboard/__tests__/service.review-time-anchor.test.ts \
  src/lib/dashboard/__tests__/aggregate-queries.review-time-anchor.test.ts \
  src/lib/kpi/__tests__/fragments.test.ts 2>&1 | tail -30
pnpm vitest run src/lib/dashboard/__tests__/review-time-anchor.integration.test.ts 2>&1 | tail -40
```

The split below is the eval's contract — record it in the commit body. **Do not weaken an assertion
to make it come out right**; a fixture that does not exercise the anchor is the bug.

| # | Test | Now | Why |
|---|---|---|---|
| 1 | velocity week bucketing | **FAIL** | buckets on `detected_at` = current week |
| 2 | sentiment trend week bucketing | **FAIL** | same |
| 3 | avg star current window | **FAIL** | reads 3, want 5 |
| 4 | rating breakdown window | **FAIL** | total 2, want 1 |
| 5 | NULL `review_date` fallback | PASS | equivalent under both anchors — regression guard |
| 6 | future `review_date` clamp | PASS | equivalent under both — guards against COALESCE, not `detected_at` |
| 7 | response rate on `detected_at` | PASS | negative control |
| 8 | feed on `detected_at` | PASS | negative control |
| 9 | avg star prior window + sample | **FAIL** | prior sample empty today, delta suppressed |
| 10 | timeSaved on `approved_at` | PASS | negative control |
| 11 | aggregate slice anchor | **FAIL** | velocity in wrong week, rating total 2 |
| 12 | aggregate counters on `detected_at` | PASS | negative control |
| 13 | aggregate zero-fill | PASS | contract preserved by the current SQL — guards the LEFT JOIN move |
| 14 | shape: anchor ×3/7/3/1 | **FAIL** | zero anchors today |
| 15 | shape: no LEAST in rate/timeSaved | PASS | negative control |
| 16 | shape: aggregate anchor ×2/1 | **FAIL** | zero anchors today |
| 17 | shape: no LEAST in counters | PASS | negative control |
| 18 | single-owner source audit | **FAIL** | `src/lib/kpi/service.ts:147` still spells both anchors and `fragments.ts` does not exist yet — T2 turns this green by moving the spelling |
| 19–20 | fragment pins | `.todo` | converted in T2 |

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "test(#757): eval — Review-time anchor on the rendered dashboard stack

Live-DB suite moved from kpi/__tests__ and re-pointed at getActiveDashboardData
+ fetchPerLocationAggregateSlices. Five negative controls pin the metrics that
must NOT move (response rate current+prior, recent-review feed, timeSaved,
aggregate counters), and a source audit pins fragments.ts as the sole speller.

Branch is deliberately RED from here until T4 — eval-first."
```

---

### Task 2: Extract the anchor fragments into their single owner

**Blocking edges:** T1.

**Files:** Create `src/lib/kpi/fragments.ts`; modify `src/lib/kpi/service.ts`,
`src/lib/kpi/__tests__/fragments.test.ts`

- [ ] **Step 1: Create the fragment module**

```typescript
// src/lib/kpi/fragments.ts
//
// Single owner of the Review-time anchor spelling (#688 ADR 0019, consolidated
// by #757). Extracted from kpi/service.ts so the RENDERED dashboard stack
// (dashboard/service.ts + dashboard/aggregate-queries.ts) composes the same
// bucketing decision instead of re-spelling it. fragments.test.ts fails if any
// non-test source file outside this one spells the anchor.
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
// behind it; a second bucketing rule would be a new ADR, not a new branch here.

import type { Sql } from 'postgres';

/** Table alias prefix at a composition site. Callers alias `reviews` as `r`. */
type ReviewsPrefix = '' | 'r.';

/**
 * Review-time anchor (#688, ADR 0019) — the timestamp the reputation KPIs
 * (velocity, rating breakdown, avg star, sentiment trend) bucket on, so a
 * consented Review import lands in its true weeks instead of spiking the
 * import week.
 *
 * LEAST ignores NULLs in Postgres: a NULL review_date falls back to
 * detected_at, and a clock-skewed FUTURE review_date clamps to detected_at
 * (unclamped, a future week silently vanishes from a trend's generate_series
 * LEFT JOIN). The anchor can never exceed detected_at.
 *
 * Workflow KPIs — response rate, the aggregate review counters, the
 * MonthlyImpactWorker digest — deliberately stay on detected_at: imported
 * unanswered reviews are MEANT to drag the rate (#675 nudge reasoning,
 * ADR 0019 D2). Action timestamps (approved_at) never use this.
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

In `src/lib/kpi/service.ts` delete the local `reviewTimeAnchor` and `reviewTimeWindowFilter`
definitions (currently ~lines 134–154) and add:

```typescript
import { reviewTimeAnchor, reviewTimeWindowFilter } from './fragments';
```

Leave `notDeletedFilter`, `detectedAtWindowFilter`, `handledStatusFilter`, `ttrSelectExpr` and
`ttrHandledWindowFilter` in place — they die with this file in T5 (see the superseding adjudication
at the top; extracting a fragment with no surviving composer is dead code).

- [ ] **Step 3: Convert the two `.todo` pins to real tests**

`sqlCalls` records inside `then()`, so simply `await` each host template.

```typescript
  it('reviewTimeAnchor emits the unprefixed and r.-prefixed spellings and nothing else', async () => {
    const harness = createMockSql();
    const sql = harness.mockSql as unknown as Sql;
    await sql`SELECT ${reviewTimeAnchor(sql, '')} AS a`;
    await sql`SELECT ${reviewTimeAnchor(sql, 'r.')} AS a`;
    expect(harness.sqlCalls[0]!.text).toBe('SELECT LEAST(review_date, detected_at) AS a');
    expect(harness.sqlCalls[1]!.text).toBe('SELECT LEAST(r.review_date, r.detected_at) AS a');
    // No FROM/JOIN and no tenant predicate may ever live in the fragment —
    // ci:tenant-scope reads raw template text and would stop seeing it.
    for (const call of harness.sqlCalls) {
      expect(call.text).not.toMatch(/\bFROM\b|\bJOIN\b|business_id|account_id/);
      expect(call.values).toEqual([]);
    }
  });

  it('reviewTimeWindowFilter binds the window as an integer parameter, never interpolated text', async () => {
    const harness = createMockSql();
    const sql = harness.mockSql as unknown as Sql;
    await sql`SELECT 1 WHERE ${reviewTimeWindowFilter(sql, '', 30)}`;
    const call = harness.sqlCalls[0]!;
    expect(call.text).toBe(
      'SELECT 1 WHERE LEAST(review_date, detected_at) >= NOW() - make_interval(days => ?)',
    );
    expect(call.text).not.toMatch(/INTERVAL\s+'\d+\s+days'/i);
    expect(call.values).toEqual([30]);
  });
```

Add the imports this needs (`createMockSql`, `type Sql`, `reviewTimeAnchor`,
`reviewTimeWindowFilter`) alongside the existing ones.

- [ ] **Step 4: Verify — Stack A unchanged, fragments pinned**

```bash
cd /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-757-dashboard-review-time-anchor
pnpm vitest run src/lib/kpi/__tests__ 2>&1 | tail -20
```

Expected: `fragments.test.ts` 3 PASS with **no `.todo` remaining**; `service.test.ts` and
`service.cache.test.ts` fully PASS — this task must not change Stack A's behavior by one byte.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "refactor(#757): extract reviewTimeAnchor + reviewTimeWindowFilter to kpi/fragments.ts

Pure move, no behavior change — Stack A composes them from the new owner.
Single-owner spelling, not a variation seam (openFlagExistsSql precedent, #730).
Supersedes Pathfinder P1's four-fragment item: the other two have no composer
once Stack A is deleted."
```

---

### Task 3: Re-anchor `dashboard/service.ts` (14 plug lines)

**Blocking edges:** T2. **Mutually independent with T4.**

**Files:** Modify `src/lib/dashboard/service.ts` — and nothing else.

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

Week-based lookbacks compose the anchor directly — `reviewTimeWindowFilter` is days-only.

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

Seven anchor occurrences — the shape test pins that exact count. `star_n_prior` is the sample size
`buildReputationSummary` uses to suppress the delta, so the prior-bucket predicates must move too.

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

- [ ] **Step 6: Update the `fetchReputationRows` doc comment**

Add to its JSDoc (~line 458):

```
 * Avg star and the sentiment trend bucket on the Review-time anchor (ADR 0019,
 * #757); response rate stays on detected_at (workflow KPI) and timeSaved keys
 * on approved_at (action timestamp) — neither may be re-anchored.
```

- [ ] **Step 7: DO NOT TOUCH — re-read before committing**

`rateRows` (480–514, all seven `r.detected_at`), `timeSavedRows` (537–554, `approved_at`),
`ORDER BY rev.detected_at DESC` (line 312), totals, ranking, pending. **Do not convert any `await`
back into a `Promise.all`** — the sequential `settledInOrder` wave and the sequential reputation
batch are #505's fix and their comments say so.

- [ ] **Step 8: Verify — own suite only**

```bash
cd /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-757-dashboard-review-time-anchor
pnpm vitest run src/lib/dashboard/__tests__/service.review-time-anchor.test.ts \
  src/lib/dashboard/__tests__/service.cache.test.ts \
  src/lib/dashboard/__tests__/service.degradation.test.ts \
  src/lib/dashboard/__tests__/service.rating-breakdown.test.ts \
  src/lib/dashboard/__tests__/service.feed-projection.test.ts \
  src/lib/kpi/__tests__/fragments.test.ts 2>&1 | tail -25
```

Expected: all PASS. **Do not run the shared `review-time-anchor.integration.test.ts` here** — its
aggregate assertions belong to T4 and will be red until T4 lands.

- [ ] **Step 9: Commit**

```bash
git add -A && git commit -m "feat(#757): re-anchor single-location dashboard reputation windows

Velocity, rating breakdown, avg star (current AND prior buckets) and the
sentiment trend compose the Review-time anchor. Response rate (workflow KPI)
and timeSaved (approved_at) deliberately unchanged — ADR 0019 D2."
```

---

### Task 4: Re-anchor `aggregate-queries.ts` + rename the reviews aliases

**Blocking edges:** T2. **Mutually independent with T3.**

**Files:** Modify `src/lib/dashboard/aggregate-queries.ts` — and nothing else.

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

**The anchor MUST stay inside the `LEFT JOIN … ON` clause.** Moved into `WHERE` it degenerates the
outer join to an inner one and a location with no reviews loses its zero-filled series entirely —
that is what live test 13 (`EMPTY_BIZ`) exists to catch.

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

- [ ] **Step 4: Annotate the slice interface**

In `PerLocationAggregateSlice` (~line 50), above the two moved fields:

```typescript
  /** Weekly counts bucketed on the Review-time anchor (ADR 0019, #757). */
  reviewVelocity: DashboardDataActive['reviewVelocity'];
  /** 1–5★ distribution over the Review-time-anchored window (ADR 0019, #757). */
  ratingBreakdown: RatingBreakdown;
```

Leave `windowedReceived` / `windowedResponded` and their `detected_at` doc comments alone — they
come from the counter query, which does not move.

- [ ] **Step 5: DO NOT TOUCH** — the counter query (156–184; `r.detected_at` at 168 and 171 feeds
the account response rate), ranking, briefs, pending counts, the fatal baseline read, or the
`settledInOrder` sequencing.

- [ ] **Step 6: Verify — own suites only**

```bash
cd /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-757-dashboard-review-time-anchor
pnpm vitest run src/lib/dashboard/__tests__/aggregate-queries.review-time-anchor.test.ts \
  src/lib/dashboard/__tests__/aggregate-queries.test.ts \
  src/lib/dashboard/__tests__/aggregate-service.test.ts \
  src/lib/dashboard/__tests__/aggregate-service.degradation.test.ts 2>&1 | tail -25
pnpm ci:tenant-scope 2>&1 | tail -20
```

`ci:tenant-scope` runs here rather than waiting for the gate — the alias rename is the one edit that
could disturb it. The audit derives aliases from the SQL text (`tableAliases`), so the rename should
be structurally invisible; prove it, don't assume it.

**Do NOT run `review-time-anchor.integration.test.ts` here** — T4.5 owns it.

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "feat(#757): re-anchor aggregate velocity + rating breakdown

Renames the reviews aliases rv/rev to r so the fragment's '' | 'r.' prefix union
covers both sites. Anchor stays in the LEFT JOIN ON clause so the per-location
zero-fill survives. Counter query (account response rate) untouched."
```

---

### Task 4.5: Integration checkpoint — the shared live-DB suite

**Blocking edges:** T3 **and** T4. This task exists so the shared suite has exactly one owner; it is
the only place it runs during implementation.

**Files:** none — verification only. If it fails, the fix belongs to whichever of T3/T4 owns the
failing metric, as a follow-up commit on that task's surface.

- [ ] **Step 1: Run the shared live-DB eval suite**

```bash
cd /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-757-dashboard-review-time-anchor
pnpm vitest run src/lib/dashboard/__tests__/review-time-anchor.integration.test.ts 2>&1 | tail -40
```

Requires a DB at migrations head (`pnpm test:db:setup`) and `TEST_DATABASE_POOL_URL` **exported into
the environment** — this suite reads `process.env` directly (via `describeWithDb`), so an unexported
value in `.env.local` makes it **silently self-skip and report green**. `verify-gate.sh` exports it
itself (:115-117) and warns if it cannot, but a manual `pnpm vitest` run does not:

```bash
export TEST_DATABASE_POOL_URL="$(grep -E '^TEST_DATABASE_POOL_URL=' .env.local | tail -1 | cut -d= -f2- | tr -d '"')"
```

Expected: all **13** live-DB tests PASS — the first moment the branch is fully green. A run reporting
"skipped" is a FAILED checkpoint, not a pass.

If any of tests 1, 2, 6, 9, 11 fails on a **Monday** run, suspect a fixture whose assertion names a
week but whose timestamps are not `NOW()` — that is the exact class of bug the AGG_BIZ fixture was
corrected for. Fix the fixture, never the assertion.

- [ ] **Step 2: Commit only if a fix was needed**

```bash
git commit -am "fix(#757): <metric> fixture/plug correction found by the shared eval suite"
```

Otherwise record the green run in the task summary and move on — a verification-only task with no
diff is a valid outcome.

---

### Task 5: Delete Stack A

**Blocking edges:** T4.5 — Stack B must already carry the anchor, proven end to end.

**Files:**
- Delete: `src/lib/kpi/service.ts`, `src/lib/kpi/__tests__/service.test.ts`, `src/lib/kpi/__tests__/service.cache.test.ts`
- Delete: `src/app/api/dashboard/kpis/route.ts`, `src/app/api/dashboard/kpis/__tests__/route.test.ts`
- Modify: `src/lib/kpi/types.ts`, `scripts/ci/tenant-scope-allowlist.ts`, `scripts/ci/__tests__/db-imports-audit.test.ts`

- [ ] **Step 1: Delete the files**

```bash
cd /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-757-dashboard-review-time-anchor
git rm src/lib/kpi/service.ts src/lib/kpi/__tests__/service.test.ts \
       src/lib/kpi/__tests__/service.cache.test.ts
git rm -r src/app/api/dashboard/kpis
```

- [ ] **Step 2: Drop the seven tenant-scope allowlist entries and lower the baseline**

`scripts/ci/tenant-scope-allowlist.ts` carries seven entries whose `file` is
`src/lib/kpi/service.ts`, under the `// --- KPI service (src/lib/kpi/service.ts) ---` header at
~line 2258. The audit fails on a stale entry (`UNUSED_ALLOWLIST_REASON = 'unused tenant scope
allowlist entry'`), so deleting the file without deleting these **breaks `pnpm ci:tenant-scope`**.

Remove the header comment and all seven entries (~lines 2258–2314), then:

```typescript
export const ALLOWLIST_BASELINE = 401;   // was 408 — seven kpi/service.ts entries removed with the file (#757)
```

The baseline must move in the same PR or the audit fails on the count mismatch — that guard is
deliberate ("any add or remove must bump ALLOWLIST_BASELINE in the same PR").

- [ ] **Step 3: Fix BOTH stale references in the CI audit test**

`scripts/ci/__tests__/db-imports-audit.test.ts` names deleted paths twice — line 102 (the route)
and line **118** (`src/lib/kpi/service.ts`). Both are pure string tests that would keep passing
while pointing at nothing:

```typescript
// line 102
    expect(isCompositionRoot('src/app/api/dashboard/route.ts', REGISTERED_WORKER_ROOTS)).toBe(true);
// line 118
    expect(isCompositionRoot('src/lib/dashboard/service.ts', REGISTERED_WORKER_ROOTS)).toBe(false);
```

`src/lib/dashboard/service.ts` is the right replacement for 118: a live domain module that is
correctly *not* a composition root, which is exactly the property that assertion checks.

- [ ] **Step 4: Drop the orphaned exports from `src/lib/kpi/types.ts`**

Remove `KpiResponseRate`, `KpiReviewVolume`, `SentimentTrendPoint`, `KpiScope` and
`DashboardKpiSummary` (lines 5–53) — zero importers once Stack A is gone. **Keep**
`DASHBOARD_WINDOWS`, `DashboardWindow`, `DEFAULT_DASHBOARD_WINDOW`, `DashboardWindowParams`,
`WINDOW_PARAMS`, `resolveDashboardWindow`, `dashboardWindowParams`. Replace the file header:

```typescript
// Canonical analytics window vocabulary for the dashboard payload. Formerly
// also held the Spec-11 launch KPI summary types; those died with the
// consumer-less Stack A KPI service (#757, Pathfinder P1). The Review-time
// anchor fragments live beside this file in ./fragments.ts.
```

- [ ] **Step 5: Prove nothing references the deleted surface**

```bash
cd /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-757-dashboard-review-time-anchor
rg -n "kpi/service|getLocationKpiSummary|getAccountKpiSummary|DashboardKpiSummary|KpiScope|KpiResponseRate|KpiReviewVolume|SentimentTrendPoint" \
   src worker scripts e2e || echo "CLEAN"
rg -n "api/dashboard/kpis" src worker scripts e2e || echo "CLEAN"
pnpm typecheck 2>&1 | tail -10
pnpm ci:tenant-scope 2>&1 | tail -10
pnpm ci:db-imports 2>&1 | tail -10
```

Expected: `CLEAN` twice, typecheck and both audits pass. Historical records
(`docs/reviews/**/blast-radius.md`, the superseded root `PLAN.md`) keep their references by design —
they are a log, not a live cross-reference.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "refactor(#757): delete the consumer-less Stack A KPI service and route

getLocationKpiSummary + getAccountKpiSummary + GET /api/dashboard/kpis had zero
consumers (verified three ways, Pathfinder P1). Drops seven now-unused
tenant-scope allowlist entries (baseline 408 -> 401) and repoints two stale
path assertions in the db-imports audit test. Window vocabulary kept."
```

---

### Task 6: Documentation

**Blocking edges:** T5.

**Files:** Modify `docs/adr/0019-kpi-review-time-anchor.md`, `CONTEXT.md`, `.claude/CLAUDE.md`, `docs/directory.md`

**Accuracy constraint for every doc edit below:** the **single-location** payload anchors four
metrics (velocity, rating breakdown, avg star, sentiment trend). The **All-Locations aggregate**
anchors only **two** (velocity, rating breakdown) — it has no avg-star or sentiment-trend query at
all. Do not write "per-location and per-account" across all four.

- [ ] **Step 1: ADR 0019 addendum**

```markdown
## Addendum — 2026-08-11 (#757): one stack, one fragment owner

#688 applied this ADR to `src/lib/kpi/service.ts`, which nothing rendered. The
customer-visible dashboard reads `src/lib/dashboard/service.ts` +
`aggregate-queries.ts`, which still bucketed on `detected_at` — so a consented
Review import produced exactly the spike this ADR removes, on the only surfaces
owners see. #757 closes that gap (Pathfinder 2026-08-10 P1):

- The anchor fragments moved to **`src/lib/kpi/fragments.ts`**, now their single
  owner, enforced by a source audit in `fragments.test.ts` that fails if any
  other non-test file spells `LEAST(review_date, detected_at)`.
- **Single-location payload:** velocity, rating breakdown, avg star (current AND
  prior buckets, so `star_n_prior` and the delta move with them) and the
  sentiment trend are anchored.
- **All-Locations aggregate:** velocity and rating breakdown are anchored. It has
  no avg-star or sentiment-trend query; its review counters
  (`windowedReceived`/`windowedResponded`) stay on `detected_at` because they
  feed the account response rate.
- Unchanged everywhere: response rate (Decision 2), timeSaved (`approved_at`),
  the recent-review feed (`detected_at` = ingestion recency), all-time totals,
  pending counts.
- `getLocationKpiSummary`, `getAccountKpiSummary` and `GET /api/dashboard/kpis`
  were **deleted** — zero consumers. Their calendar-month volume MoM and TTR
  duration metrics have never rendered anywhere; when the deferred KPI-cards work
  ships it extends the dashboard payload composing the same fragments.

**Supersedes P1 item 1 on one point.** P1 required extracting four fragments;
only `reviewTimeAnchor` and `reviewTimeWindowFilter` were extracted. Once Stack A
is deleted, `detectedAtWindowFilter` and the TTR validity filter have zero
composers — Stack B's response rate stays literal per Decision 2, and Stack B has
no duration metric. Decision 3 (the TTR validity filter) is therefore **recorded
but no longer implemented in code**; it returns with the metric.

**Deferred, recorded here so it is not rediscovered as a surprise.** The relevant
indexes are composite — `idx_reviews_business_detected_at` (migration 010) and
`idx_reviews_business_review_date` (migration 031), both `(business_id, <ts>)`.
`LEAST(review_date, detected_at) >= …` is not sargable on either, so these reads
keep the `business_id` prefix but lose the timestamp as a range key: they become
prefix-scan-plus-filter. At the #474 Capacity target (250 locations, ~125
reviews/day) per-business row counts are small, and Stack A has run this way
since #688. Revisit with an expression index only if dashboard read latency
regresses — that is a migration, and this ADR's no-migration property is
deliberate. The All-Locations aggregate is the path to measure first: it scans
every active location of an account in one statement.
```

- [ ] **Step 2: `CONTEXT.md` — Review-time anchor entry**

Replace `One owner: `reviewTimeAnchor` (`src/lib/kpi/service.ts`).` with:

```
One owner: `reviewTimeAnchor` (`src/lib/kpi/fragments.ts`), composed by the rendered dashboard payload — velocity, rating breakdown, avg star and sentiment trend per-location, and velocity + rating breakdown in the All-Locations aggregate (#757).
```

- [ ] **Step 3: `.claude/CLAUDE.md` — Customer KPIs bullet**

```markdown
- **Customer KPIs**: the dashboard payload (`src/lib/dashboard/*`) is the ONE KPI stack — per-location `getActiveDashboardData` and per-account `fetchPerLocationAggregateSlices`, served by `GET /api/dashboard`. Reputation metrics bucket on the **Review-time anchor** `LEAST(review_date, detected_at)` via the single-owner fragments in `src/lib/kpi/fragments.ts` (#688/#757, ADR 0019): velocity, rating breakdown, avg star and sentiment trend per-location; velocity and rating breakdown in the aggregate. Workflow metrics stay on `detected_at` (response rate, the aggregate `windowedReceived`/`windowedResponded` counters), timeSaved keys on `approved_at`, and the recent-review feed orders on `detected_at`. `src/lib/kpi/` holds only the window vocabulary (`types.ts`) and those fragments — the consumer-less `getLocationKpiSummary`/`getAccountKpiSummary` + `GET /api/dashboard/kpis` were deleted in #757.
```

- [ ] **Step 4: `docs/directory.md`**

`docs/directory.md` currently has **no** `src/lib/kpi/` entry and **no**
`src/app/api/dashboard/kpis/` row — verify with `rg -n "kpi" docs/directory.md` before editing. So
this is an **addition, not an edit**, and there is no route row to remove.

Add a `kpi/` section immediately after the `### \`dashboard/\`` section (~line 459), matching that
file's established `### \`dir/\`` + one-line description + `| File | What it does |` table format:

```markdown
### `kpi/`

Analytics window vocabulary and the Review-time anchor fragments the dashboard payload composes.
No service layer — the consumer-less Stack A KPI service was deleted in #757.

| File | What it does |
|------|--------------|
| `types.ts` | `DASHBOARD_WINDOWS` / `DashboardWindow` / `resolveDashboardWindow` / `dashboardWindowParams` — the only window values that may reach windowed SQL, as bound integers (#403). |
| `fragments.ts` | `reviewTimeAnchor` / `reviewTimeWindowFilter` — single owner of the Review-time anchor `LEAST(review_date, detected_at)` (ADR 0019). Composed by `dashboard/service.ts` + `dashboard/aggregate-queries.ts`; carries no FROM/JOIN and no tenant predicate. |
```

While there, fix the stale `dashboard/service.ts` row in the section above it: it describes a
`buildDashboardData(businessId)` function that no longer exists — the export is
`getActiveDashboardData`.

- [ ] **Step 5: Verify and commit**

```bash
cd /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-757-dashboard-review-time-anchor
rg -n "kpi/service|api/dashboard/kpis" docs/directory.md CONTEXT.md .claude/CLAUDE.md || echo "CLEAN"
git add -A && git commit -m "docs(#757): ADR 0019 addendum, CONTEXT.md owner path, CLAUDE.md KPI stack, directory entry"
```

---

### Task 7: Staging smoke (step 8 lane — not part of the branch diff)

**Blocking edges:** T6, and the branch being pushed to `staging`.

The locked intake names this as the **only** semantic backstop in production: a syntactically valid
but semantically wrong anchor emits no Sentry signal. Run it after the branch lands on `staging`,
before opening the PR to `main`. Capture output to
`docs/runbooks/evidence/2026-08-11-757-anchor-staging-smoke.md`.

- [ ] **Step 1: Seed an isolated import-shaped fixture on the staging Supabase project**

Use a scratch location you own on staging. All time arithmetic in SQL.

Seed at **exact day offsets**, not Monday-aligned week starts: `DATE_TRUNC('week', NOW()) - N weeks`
lands 0–6 days earlier than `NOW() - N weeks` depending on the weekday, which makes "is week 4 still
inside the 30-day window?" answer differently on a Wednesday than on a Monday. Day offsets make the
window membership deterministic on every run.

```sql
-- Replace :biz with the staging business_id under test.
-- Offsets 7/14/21/28 days are ALL inside the 30-day window; 45 is outside it but
-- still inside the 8-week velocity series. Five distinct ISO weeks either way.
INSERT INTO reviews (id, business_id, provider, provider_review_id, provider_review_name,
                     provider_location_name, reviewer_name, star_rating, review_text,
                     sentiment_score, review_date, detected_at, status)
SELECT gen_random_uuid(), :biz, 'zernio',
       'smoke-757-' || d, 'zernio://smoke-757/reviews/' || d,
       'zernio://smoke-757/locations/1', 'Smoke 757', 4, 'anchor smoke',
       0.5,
       NOW() - (d || ' days')::interval,  -- true review time
       NOW(),                             -- import time = today
       'new'
FROM unnest(ARRAY[7, 14, 21, 28, 45]) d;
```

- [ ] **Step 2: Wait out the 45s cache, then capture BOTH payloads whole**

The payload is Redis-cached at 45s (`dashboard:location:<biz>:30d:rep`), so a read within 45s of
seeding serves the pre-seed payload. Capture the full JSON to disk — the assertions below span
fields a narrow `jq` filter would discard, and the files become the evidence.

```bash
# authenticated as the owner of :biz on staging
sleep 50
curl -s -b "$STAGING_COOKIE" "$STAGING_URL/api/dashboard"            > /tmp/757-single.json
curl -s -b "$STAGING_COOKIE" "$STAGING_URL/api/dashboard?scope=all"  > /tmp/757-aggregate.json

jq '{velocity: .reviewVelocity, trend: .reputationSummary.trend,
     rating: .ratingBreakdown, rate: .reputationSummary.responseRate}' /tmp/757-single.json
# Aggregate exposes per-location series as .perLocationVelocity[] — there is no .locations[].
jq '{combined: .reviewVelocity, perLocation: .perLocationVelocity, rating: .ratingBreakdown}' \
   /tmp/757-aggregate.json
```

- [ ] **Step 3: Assert the shape of the answer, not just a 200**

- **`reviewVelocity` shows five distinct non-zero weeks**, not a single spike in the current week.
  This is the whole point of the change; a current-week spike of 5 means the anchor did not apply.
- `reputationSummary.trend` spreads across those same weeks.
- `ratingBreakdown.total` counts **4** of the seeded rows — the 7/14/21/28-day rows are inside the
  30-day review-time window; the 45-day row is outside it.
- `perLocationVelocity` shows the same five-week spread for that location, and the combined
  `reviewVelocity` agrees with it.
- `reputationSummary.responseRate.current` reflects **all five** imports as received (they were all
  detected today) and none as handled — the workflow KPI is deliberately untouched by the anchor,
  and seeing it move would mean response rate was wrongly re-anchored.

- [ ] **Step 4: Clean up in FK order**

```sql
DELETE FROM responses WHERE review_id IN (SELECT id FROM reviews WHERE provider_review_id LIKE 'smoke-757-%');
DELETE FROM reviews WHERE provider_review_id LIKE 'smoke-757-%';
```

- [ ] **Step 5: Record evidence** — paste both curl outputs and the four assertions into the
evidence file and commit it on the branch before opening the PR.

---

## Gate (step 5 of the /feature workflow — runs outside these tasks)

Task-local checks are deliberately narrow. Before any review round, the branch must pass the full
gate from the worktree root:

```bash
cd /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-757-dashboard-review-time-anchor
bash scripts/verify-gate.sh          # lint, typecheck, full test, build, promised-tests, and every
                                     # ci:* audit EXCEPT ci:fallow* (which runs in its own workflow)
bash scripts/verify-gate.sh --review # adds coverage + changed-line diff-coverage before step 7
```

`db_touching: true` in the intake, so the gate provisions the test DB serially and **runs** the
changed `*.integration.test.ts` suite. A gate run that prints the `TEST_DATABASE_POOL_URL` SKIP
warning is **not** review-ready for this feature — set the variable and re-run. `pnpm test:integration`
does not hard-gate this suite (CLAUDE.md gotcha, the #520 class), which is precisely why the gate
must run it.

## Out of scope (intake non-goals — reject in review if they appear)

Re-anchoring response rate / the aggregate counters / the MonthlyImpactWorker digest · re-anchoring
timeSaved or the recent-review feed · preserving Stack A's volume MoM or TTR duration metrics ·
extracting `detectedAtWindowFilter` or a TTR validity fragment · an expression index or any
migration · the null-vs-0 empty-state divergence · editing historical `docs/reviews/**` or root
`PLAN.md` · reintroducing any concurrent `Promise.all` fan-out on the shared pool.

## Review appendix — codex plan review, round 1 (2026-08-11)

Full log: `.feature/logs/codex-plan-round1.log`. Verdict **REVISE**; 3 BLOCKER, 16 MAJOR, 4 MINOR.
I independently verified every load-bearing factual claim against the code before accepting.

**Accepted (22)** — all folded into this revision:

| Sev | Finding | Where fixed |
|---|---|---|
| BLOCKER | Week assertions used `::text`; postgres.js decodes `date` → JS `Date` and the mappers `String()` it, so they could never match | T1 `weekMarkers()` selects `::date` + `String()` |
| BLOCKER | `AGG_BIZ` import at 21 days sits *inside* the 30d rating window — planned SQL yields total 2, not 1 | T1 fixture moved to 42 days back |
| BLOCKER | Deleting `kpi/service.ts` strands 7 tenant-scope allowlist entries; audit fails on unused entries, and the file was outside the edit surface | T5 Step 2 + surface amendment #1 |
| MAJOR | Test 6's "weekend RED" was false — `detected_at` already clamps identically; it only distinguishes LEAST from COALESCE | T1 fixture `+8 days`, relabelled a COALESCE regression guard |
| MAJOR | `find('handled_prior')` matched the rate query, so timeSaved was never inspected | T1 selects by markers unique to each query |
| MAJOR | `seedPostedResponse` ported but unused → ESLint `no-unused-vars` error | Used by the new timeSaved + response-rate-prior fixtures |
| MAJOR | Test 10's lookbehind regex missed `DATE_TRUNC`, `GROUP BY`, upper bounds, whitespace | Strip-anchor-then-assert + exact occurrence counts (3/7/3/1, 2/1) |
| MAJOR | Avg star proved only `.current`; prior window, `star_n_prior`, delta unproven | New test 9 (45-day fixture pins prior + delta) |
| MAJOR | Aggregate counters and response-rate prior had no live proof | New test 12; test 7 extended with a prior-window fixture |
| MAJOR | Aggregate velocity asserted bucket existence only; an OR could double-count | Exact per-week counts + series total |
| MAJOR | Zero-fill contract unprotected if the anchor moves to `WHERE` | New test 13 (`EMPTY_BIZ`) |
| MAJOR | Everything could pass with Stack B hand-spelling LEAST and `fragments.ts` unused | New single-owner source audit in `fragments.test.ts` |
| MAJOR | "Every intermediate commit is shippable" was false | Red-branch reality stated; per-task suites narrowed; shared suite runs once after T3+T4 |
| MAJOR | Staging smoke named as the only semantic backstop but had no executable task | New Task 7 |
| MAJOR | Plan cited P1 as decision of record while reversing its four-fragment item | Explicit superseding adjudication at the top + ADR addendum |
| MAJOR | `db-imports-audit.test.ts` stale at line **118** too, not just 102 | T5 Step 3 fixes both |
| MAJOR | `docs/directory.md` has no kpi entry and no route row to remove | T6 Step 4 rewritten as an addition |
| MAJOR | Doc text claimed avg star + trend are anchored per-account; the aggregate has neither query | Accuracy constraint + corrected ADR/CONTEXT/CLAUDE text |
| MAJOR | No final full-repo gate in the plan | New "Gate" section |
| MINOR | "9 importers" stale | Count removed |
| MINOR | "Port VERBATIM" would carry Stack-A header prose | T1 Step 1 rewrites the header, ports only the conventions |
| MINOR | ADR called the indexes single-column; both are composite | Addendum rewritten with the real index names + the aggregate-path measurement note |
| MINOR | Task graph listed shape-test files under T3/T4 | Graph corrected — every test file is authored in T1 |

**Partially rejected (1)** — "make T3/T4 atomic". The two tasks edit genuinely disjoint production
files and have no data dependency; collapsing them would produce one larger, harder-to-review diff.
The real defect was the false shippability claim and the shared red suite, both fixed above by
narrowing each task's verification and running the shared suite once after both land.

## Review appendix — codex plan review, round 2 (verification-only)

Log: `.feature/logs/codex-plan-round2.log`. Verdict **REVISE**; **19 of 23 round-1 findings
verified FIXED**, 1 NOT FIXED, 6 fixes introduced defects. No new fronts, empty appendix. All seven
are corrected in revision 3:

| Sev | Round-2 finding | Fix in revision 3 |
|---|---|---|
| BLOCKER | #1 residue — `AGG_BIZ`'s "current week" review seeded at `NOW() - interval '1 day'`, which is the PRIOR ISO week every Monday | Seeded at `NOW()`; rule added: any fixture whose assertion names a week is seeded at `NOW()` |
| MAJOR | #10 inherited the same Monday failure | Same fix (one fixture, two findings) |
| MAJOR | #5 NOT FIXED — `find('FROM responses resp')` matches the rate query's EXISTS subqueries (`service.ts:488,502`) before timeSaved (`:546`), so the timeSaved control asserted against the wrong query and would fail forever | `findOnly()` **throws** on an ambiguous marker (both suites), and timeSaved is selected by `JOIN reviews r ON r.id = resp.review_id` — verified to occur exactly once |
| MAJOR | #13 — shared-suite ownership contradictory ("T4's final step" vs "whichever finishes second", while T3 says never run it) | New **Task 4.5**, a checkpoint task depending on T3+T4 that is the sole owner of the shared suite; T5 now blocks on it |
| MAJOR | #14 — Task 7 not executable: `.locations[]` does not exist (payload has `.perLocationVelocity[]`), narrow `jq` discarded fields the evidence needs, and "weeks 1–4 within 30 days" is false from Wednesday | Day-offset seeds (7/14/21/28/45), full payloads captured to disk, corrected `jq` paths, exact `ratingBreakdown.total === 4` |
| MINOR | Test 18 marked PASS at T1, but `kpi/service.ts:147` still spells the anchor then | Table row corrected to FAIL → green at T2 |
| MINOR | `docs/directory.md` addition did not match the file's `### dir/` + table format | Rewritten in the real format, placed after the `dashboard/` section; also fixes that section's stale `buildDashboardData` row |
| MINOR | Gate comment said "every `ci:*` audit"; `verify-gate.sh` excludes `ci:fallow*` | Wording corrected |

## Self-review

- **Spec coverage** — #757 task 1 (re-anchor reputation windows) → T3+T4; task 2 (adjudicate the
  consumer-less route) → T5, deleted; task 3 (extend the TTR validity filter to any dashboard
  duration metric) → none exists, recorded in the ADR addendum.
- **Placeholders** — none: every step carries the literal SQL/TypeScript it changes.
- **Type consistency** — `reviewTimeAnchor(sql, prefix)` / `reviewTimeWindowFilter(sql, prefix,
  windowDays)` are spelled identically in T2, T3 and T4; `ReviewsPrefix` is `'' | 'r.'` everywhere,
  which T4's alias rename is what keeps true.
