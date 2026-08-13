// src/lib/dashboard/__tests__/review-time-anchor.integration.test.ts
//
// EVAL suite for #757 — the Review-time anchor on the RENDERED dashboard stack
// (getActiveDashboardData + fetchPerLocationAggregateSlices). #688 proved these
// semantics against Stack A, which nothing renders; this proves them where owners
// actually read them. The mocked suites
// (service.review-time-anchor.test.ts / aggregate-queries.review-time-anchor.test.ts)
// pin the SQL SPELLING every day; this suite proves the bucketing MEANS what
// ADR 0019 decided, against real Postgres.
//
// Domain language (CONTEXT.md): the Review-time anchor is LEAST(review_date,
// detected_at) — the timestamp reputation KPIs bucket on so a Review import (the
// consented one-time storage of an owner's Google reviews, detected_at = import
// time and review_date = the original Google timestamp) lands in its true
// weeks instead of spiking the import week. LEAST ignores NULLs (NULL
// review_date falls back to detected_at) and clamps a clock-skewed FUTURE
// review_date to detected_at. Workflow KPIs — response rate and the aggregate
// review counters — deliberately stay on detected_at (ADR 0019 D2), timeSaved
// keys on approved_at, and the recent-review feed orders on detected_at
// (ingestion recency). Five of the thirteen tests below are those negative
// controls.
//
// Live-DB conventions (CLAUDE.md gotcha, ci:live-db-suites): named
// *.integration.test.ts so vitest serializes it in the `integration` project,
// gated by describeWithDb, ASSERTS its schema with assertSchemaReady, and
// NEVER applies migration SQL — provisioning is `pnpm test:db:setup`'s job.
// Fixtures are DML-only, and ALL time arithmetic happens in SQL
// (NOW() - interval '…' / make_interval) — never via a JS Date.
//
// Accepted timing risks (#688 round-1 review, adjudicated wontfix): fixtures
// seed from NOW() in beforeAll while assertions recompute DATE_TRUNC week
// buckets at assert time — a run straddling a calendar boundary in that
// seconds-wide window fails loudly and a rerun passes; deterministic clock
// injection would widen the production interface (NOW() is baked into the
// dashboard queries). Two rules keep that risk from becoming a real flake:
// any fixture whose assertion NAMES a week is seeded at NOW(), never
// NOW() - interval '1 day' (a 1-day-old row is in the prior ISO week every
// Monday), and expected week starts are selected as ::text so Postgres renders
// the ISO calendar day the mappers now emit — since #791 a JS-Date round-trip
// expectation can never match (see weekMarkers below).

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import type postgresType from 'postgres';
import { describeWithDb } from '@/__tests__/helpers/describe-with-db';
import {
  cleanupLocation,
  cleanupTenantAccount,
  seedLocation,
  seedTenantAccount,
  type TenantSeed,
} from '@/lib/shared/__tests__/live-db-tenant';
import {
  assertSchemaReady,
  MIGRATION_071_RUN_SPINE,
} from '@/lib/shared/__tests__/helpers/schema-ready';
import { REVIEW_STATUS } from '@/lib/reviews/status';
import { HANDLED_STATUSES } from '@/lib/shared/response-status';
import { APPROVAL_METHOD } from '@/lib/auto-approval/types';
import { getActiveDashboardData } from '../service';
import { fetchPerLocationAggregateSlices } from '../aggregate-queries';

// The dashboard payload reads the Upstash cache first; the always-miss stub
// keeps this suite Postgres-only (the cache contract lives in service.cache.test.ts).
vi.mock('@/lib/db/redis-cache', () => ({
  getCacheRedis: () => ({ get: async () => null, set: async () => 'OK' }),
  withTtlCache: async <T>(
    _key: string,
    _ttlSeconds: number,
    compute: () => Promise<T>,
  ): Promise<T> => compute(),
}));

// responses.status has no per-value constant export — shared/response-status.ts
// owns the named GROUPS, and state-transition sites keep narrow inline lists by
// design. `satisfies` anchors this fixture's posted status to that authoritative
// vocabulary instead of leaving a free-floating literal.
const POSTED = 'posted' satisfies (typeof HANDLED_STATUSES)[number];

const testDatabaseUrl = process.env.TEST_DATABASE_POOL_URL;

let db: postgresType.Sql | undefined;
let tenant: TenantSeed | undefined;

// One ISOLATED business per metric cluster: the single-location payload is
// per-business, so per-cluster isolation makes every expectation exact.
const VELOCITY_BIZ = randomUUID(); // t1  velocity week bucketing
const TREND_BIZ = randomUUID(); // t2  sentiment-trend week bucketing
const STAR_BIZ = randomUUID(); // t3 + t10  avg-star current & prior windows
const RATING_BIZ = randomUUID(); // t4  rating-breakdown window
const NULLFB_BIZ = randomUUID(); // t5  NULL review_date fallback
const FUTURE_BIZ = randomUUID(); // t6  future review_date clamp
const RATE_BIZ = randomUUID(); // t7  response-rate detected_at pin (negative control)
const FEED_BIZ = randomUUID(); // t8  recent-review feed detected_at pin (negative control)
const TIMESAVED_BIZ = randomUUID(); // t11 timeSaved approved_at pin (negative control)
const AGG_BIZ = randomUUID(); // t9 + t12  aggregate anchor + counter negative control
const EMPTY_BIZ = randomUUID(); // t13 aggregate zero-fill
const ALL_BIZ = [
  VELOCITY_BIZ,
  TREND_BIZ,
  STAR_BIZ,
  RATING_BIZ,
  NULLFB_BIZ,
  FUTURE_BIZ,
  RATE_BIZ,
  FEED_BIZ,
  TIMESAVED_BIZ,
  AGG_BIZ,
  EMPTY_BIZ,
] as const;

function sql(): postgresType.Sql {
  if (!db) throw new Error('review-time anchor integration database was not initialized');
  return db;
}

interface SeedReviewSpec {
  star: number | null;
  /**
   * SQL fragment (or NULL) — the review's ORIGINAL Google timestamp. Always a
   * fragment so the arithmetic runs in Postgres, never in a JS Date.
   */
  reviewDate: postgresType.Fragment | null;
  /** SQL fragment — when RepWorth first stored the review. */
  detectedAt: postgresType.Fragment;
  sentimentScore?: number;
}

async function seedReview(bizId: string, spec: SeedReviewSpec): Promise<string> {
  const reviewId = randomUUID();
  const marker = `dashboard-anchor-${randomUUID()}`;
  await sql()`
    INSERT INTO reviews (
      id, business_id, provider, provider_review_id, provider_review_name,
      provider_location_name, reviewer_name, star_rating, review_text,
      sentiment_score, review_date, detected_at, status
    ) VALUES (
      ${reviewId}::uuid, ${bizId}::uuid, 'zernio',
      ${marker}, ${`zernio://dashboard-anchor/reviews/${marker}`},
      'zernio://dashboard-anchor/locations/1', 'Dashboard Anchor Customer',
      ${spec.star}, 'Dashboard anchor fixture review',
      ${spec.sentimentScore ?? null},
      ${spec.reviewDate ?? null}, ${spec.detectedAt},
      ${REVIEW_STATUS.NEW}
    )
  `;
  return reviewId;
}

async function seedPostedResponse(
  reviewId: string,
  bizId: string,
  approvedAt: postgresType.Fragment,
): Promise<void> {
  await sql()`
    INSERT INTO responses (
      id, review_id, business_id, response_text, original_draft_text,
      approved_text, response_language, version, status, approval_method,
      approved_at, posted_at
    ) VALUES (
      ${randomUUID()}::uuid, ${reviewId}::uuid, ${bizId}::uuid,
      'Thank you!', 'Thank you!', 'Thank you!', 'en', 1,
      ${POSTED}, ${APPROVAL_METHOD.OWNER}, ${approvedAt}, NOW()
    )
  `;
}

/** Reputation metrics are opt-in; every assertion below needs the batch. */
async function rep(bizId: string) {
  return getActiveDashboardData(sql(), bizId, { includeReputationMetrics: true });
}

/**
 * Expected week starts as ISO `YYYY-MM-DD`, selected `::text` so Postgres — not
 * a JS Date round-trip — renders the calendar day. This inverts the pre-#791
 * rule ("stringify through the same postgres.js decode + String() path the
 * mappers use, NEVER ::text"): back then the mappers emitted
 * `Date.prototype.toString()`, so only a matching JS round-trip could match
 * them. `toIsoWeekStart` now emits the ISO day, so `::text` is the expectation
 * that matches — and it is the stronger one, because it cannot silently agree
 * with the mapper on a wrong shape the way the old symmetric path did.
 */
async function weekMarkers() {
  const [row] = await sql()<{ current_week: string; back3: string; back6: string }[]>`
    SELECT (DATE_TRUNC('week', NOW())::date)::text AS current_week,
           ((DATE_TRUNC('week', NOW()) - interval '21 days')::date)::text AS back3,
           ((DATE_TRUNC('week', NOW()) - interval '42 days')::date)::text AS back6
  `;
  return {
    currentWeek: row!.current_week,
    back3: row!.back3,
    back6: row!.back6,
  };
}

describeWithDb(
  'Review-time anchor on the rendered dashboard stack, against live Postgres',
  { timeout: 30_000 },
  () => {
    beforeAll(async () => {
      db = postgres(testDatabaseUrl!, { max: 1, prepare: false });
      // #757 ships NO migration of its own. Every column this suite touches
      // (review_date/detected_at/sentiment_score, responses.approved_at)
      // predates 071, so the run-spine floor is a valid head proxy — a
      // behind-head container fails loudly with the actionable
      // `pnpm test:db:setup` message instead of a confusing assertion failure.
      await assertSchemaReady(db, [MIGRATION_071_RUN_SPINE]);
      tenant = await seedTenantAccount(db, {
        userName: 'Dashboard Anchor Owner',
        accountDisplayName: 'Dashboard Anchor Account',
      });
      for (const [bizId, name] of [
        [VELOCITY_BIZ, 'Velocity'],
        [TREND_BIZ, 'Trend'],
        [STAR_BIZ, 'Star'],
        [RATING_BIZ, 'Rating'],
        [NULLFB_BIZ, 'Null Fallback'],
        [FUTURE_BIZ, 'Future'],
        [RATE_BIZ, 'Rate'],
        [FEED_BIZ, 'Feed'],
        [TIMESAVED_BIZ, 'Time Saved'],
        [AGG_BIZ, 'Aggregate'],
        [EMPTY_BIZ, 'Empty'],
      ] as const) {
        await seedLocation(db, tenant.accountId, {
          businessId: bizId,
          name: `Dashboard Anchor ${name} Location`,
          // businesses_account_primary_uniq permits ONE primary per account;
          // seedLocation defaults isPrimary true, so only the first cluster is.
          isPrimary: bizId === VELOCITY_BIZ,
        });
      }

      // t1 — imported review written three weeks back (Monday-aligned), stored today.
      await seedReview(VELOCITY_BIZ, {
        star: 4,
        reviewDate: sql()`DATE_TRUNC('week', NOW()) - interval '21 days'`,
        detectedAt: sql()`NOW()`,
      });

      // t2 — same shape plus a sentiment score so the trend has a value.
      await seedReview(TREND_BIZ, {
        star: 4,
        sentimentScore: 0.8,
        reviewDate: sql()`DATE_TRUNC('week', NOW()) - interval '21 days'`,
        detectedAt: sql()`NOW()`,
      });

      // t3 + t10 — a 1★ import 45 days back (OUTSIDE the 30d current window,
      // INSIDE the 60d prior window) beside an organic in-window 5★. Anchored:
      // current 5 from one sample, prior 1 from one sample, delta +4. On
      // detected_at both land in current (avg 3) and prior is empty (delta
      // suppressed) — so this one fixture pins the current window, the prior
      // window, star_n_prior AND the delta.
      await seedReview(STAR_BIZ, {
        star: 1,
        reviewDate: sql()`NOW() - interval '45 days'`,
        detectedAt: sql()`NOW()`,
      });
      await seedReview(STAR_BIZ, {
        star: 5,
        reviewDate: sql()`NOW() - interval '1 day'`,
        detectedAt: sql()`NOW() - interval '1 day'`,
      });

      // t4 — same shape for the rating breakdown (60 days back: outside the 30d window).
      await seedReview(RATING_BIZ, {
        star: 1,
        reviewDate: sql()`NOW() - interval '60 days'`,
        detectedAt: sql()`NOW()`,
      });
      await seedReview(RATING_BIZ, {
        star: 5,
        reviewDate: sql()`NOW() - interval '1 day'`,
        detectedAt: sql()`NOW() - interval '1 day'`,
      });

      // t5 — no review_date at all: LEAST ignores NULLs, anchor falls back to detected_at.
      await seedReview(NULLFB_BIZ, {
        star: 4,
        sentimentScore: 0.4,
        reviewDate: null,
        detectedAt: sql()`NOW()`,
      });

      // t6 — provider clock skew. +8 days (NOT +2) guarantees a LATER ISO week
      // EVERY day of the week, so a naive COALESCE(review_date, detected_at)
      // lands in a week generate_series never emits and the row vanishes —
      // failing live, every day.
      await seedReview(FUTURE_BIZ, {
        star: 3,
        sentimentScore: 0.5,
        reviewDate: sql()`DATE_TRUNC('week', NOW()) + interval '8 days'`,
        detectedAt: sql()`NOW()`,
      });

      // t7 — imported UNANSWERED review (current window) + an answered one in
      // the PRIOR window, so the prior rate and its sample size are pinned too.
      await seedReview(RATE_BIZ, {
        star: 2,
        reviewDate: sql()`NOW() - interval '200 days'`,
        detectedAt: sql()`NOW()`,
      });
      const ratePrior = await seedReview(RATE_BIZ, {
        star: 5,
        reviewDate: sql()`NOW() - interval '45 days'`,
        detectedAt: sql()`NOW() - interval '45 days'`,
      });
      await seedPostedResponse(ratePrior, RATE_BIZ, sql()`NOW() - interval '44 days'`);

      // t8 — imported review (ancient review_date, detected today) beside an
      // older-detected organic one.
      await seedReview(FEED_BIZ, {
        star: 2,
        reviewDate: sql()`NOW() - interval '200 days'`,
        detectedAt: sql()`NOW()`,
      });
      await seedReview(FEED_BIZ, {
        star: 5,
        reviewDate: sql()`NOW() - interval '2 days'`,
        detectedAt: sql()`NOW() - interval '2 days'`,
      });

      // t11 — ancient imported review answered TODAY. timeSaved keys on
      // approved_at, so it counts in the current window no matter what the
      // anchor says.
      const tsReview = await seedReview(TIMESAVED_BIZ, {
        star: 3,
        reviewDate: sql()`NOW() - interval '300 days'`,
        detectedAt: sql()`NOW()`,
      });
      await seedPostedResponse(tsReview, TIMESAVED_BIZ, sql()`NOW() - interval '1 hour'`);

      // t9 + t12 — aggregate: one import SIX weeks back (inside the 8-week
      // velocity series, OUTSIDE the 30d rating window) answered today, plus one
      // organic this week.
      const aggImport = await seedReview(AGG_BIZ, {
        star: 1,
        reviewDate: sql()`DATE_TRUNC('week', NOW()) - interval '42 days'`,
        detectedAt: sql()`NOW()`,
      });
      await seedPostedResponse(aggImport, AGG_BIZ, sql()`NOW() - interval '1 hour'`);
      // NOW() for BOTH timestamps, not NOW() - interval '1 day': this fixture
      // asserts a CURRENT-WEEK bucket, and on a Monday run a 1-day-old row
      // belongs to the prior ISO week. Any fixture whose assertion names a week
      // must be seeded at NOW().
      await seedReview(AGG_BIZ, {
        star: 5,
        reviewDate: sql()`NOW()`,
        detectedAt: sql()`NOW()`,
      });

      // t13 — EMPTY_BIZ gets no reviews at all (zero-fill contract).
    });

    afterAll(async () => {
      if (!db) return;
      if (tenant) {
        // FK order: responses reference reviews reference businesses.
        for (const bizId of ALL_BIZ) {
          await sql()`DELETE FROM responses WHERE business_id = ${bizId}::uuid`;
          await sql()`DELETE FROM reviews WHERE business_id = ${bizId}::uuid`;
          await cleanupLocation(sql(), bizId);
        }
        await cleanupTenantAccount(sql(), tenant);
      }
      await db.end({ timeout: 5 });
    });

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
      expect(
        data.reputationSummary!.trend.find((p) => p.weekStart === currentWeek)?.reviewCount,
      ).toBe(1);
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
  },
);
