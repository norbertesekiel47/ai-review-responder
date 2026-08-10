// src/lib/kpi/__tests__/service.anchor.integration.test.ts
//
// EVAL suite for #688 — Review-time anchor semantics. The mocked suite
// (service.test.ts) asserts the SHAPE of the SQL; this proves the bucketing
// MEANS what #688 decided, against real Postgres: LEAST NULL-skip, week/month
// bucketing, and the TTR validity filter.
//
// Domain language (#688): the Review-time anchor is LEAST(review_date,
// detected_at) — the timestamp reputation KPIs (volume MoM, sentiment trend,
// avg star) will bucket on after #688. A Review import — the consented
// one-time storage of an owner's Google reviews with detected_at = import
// time and review_date = the original Google timestamp — must land in its
// true months/weeks instead of spiking the import month. Response rate
// deliberately stays on detected_at (workflow KPI); time-to-respond will
// exclude approved_at < detected_at rows.
//
// Live-DB conventions (CLAUDE.md gotcha, ci:live-db-suites): named
// *.integration.test.ts so vitest serializes it in the `integration` project,
// gated by describeWithDb, ASSERTS its schema with assertSchemaReady, and
// NEVER applies migration SQL — provisioning is `pnpm test:db:setup`'s job.
// Fixtures are DML-only, and ALL time arithmetic happens in SQL
// (NOW() - interval '…' / make_interval) — never via a JS Date.
//
// Accepted timing risks (#688 round-1 review, adjudicated wontfix): fixtures
// seed from NOW() in beforeAll while assertions recompute DATE_TRUNC
// month/week buckets at assert time — a run straddling a calendar boundary
// in that seconds-wide window fails loudly and a rerun passes; deterministic
// clock injection would widen the production interface (NOW() is baked into
// the KPI queries). Relatedly, the future-clamp fixture (NOW() + 2 days)
// only lands in a LATER ISO week on Sat/Sun runs, so this suite's live
// distinction between LEAST and a naive COALESCE is weekend-only — the mock
// suite's LEAST( template pins are the every-day backstop.

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
import { getAccountKpiSummary, getLocationKpiSummary } from '../service';
import type { DashboardKpiSummary } from '../types';

// KPI summaries read the Upstash cache first; the always-miss stub keeps this
// suite Postgres-only (the cache contract lives in service.cache.test.ts).
vi.mock('@/lib/db/redis-cache', () => ({
  getCacheRedis: () => ({ get: async () => null, set: async () => 'OK' }),
}));

// responses.status has no per-value constant export — shared/response-status.ts
// owns the named GROUPS, and state-transition sites keep narrow inline lists by
// design. `satisfies` anchors this fixture's posted status to that authoritative
// vocabulary instead of leaving a free-floating literal.
const POSTED = 'posted' satisfies (typeof HANDLED_STATUSES)[number];

const testDatabaseUrl = process.env.TEST_DATABASE_POOL_URL;

let db: postgresType.Sql | undefined;
let tenant: TenantSeed | undefined;

// One ISOLATED business per KPI cluster: location-scope summaries are
// per-business, so per-cluster isolation makes every expectation exact.
const VOLUME_BIZ = randomUUID(); // test 1 — volume MoM month bucketing
const TREND_BIZ = randomUUID(); // test 2 — sentiment-trend week bucketing
const STAR_BIZ = randomUUID(); // test 3 — avg-star window membership
const NULLFB_BIZ = randomUUID(); // test 4 — NULL review_date fallback
const FUTURE_BIZ = randomUUID(); // test 5 — future review_date clamp
const RATE_BIZ = randomUUID(); // test 6 — response-rate detected_at pin
const TTR_BIZ = randomUUID(); // tests 7+8 — time-to-respond validity
const ALL_BIZ = [
  VOLUME_BIZ,
  TREND_BIZ,
  STAR_BIZ,
  NULLFB_BIZ,
  FUTURE_BIZ,
  RATE_BIZ,
  TTR_BIZ,
] as const;

function sql(): postgresType.Sql {
  if (!db) throw new Error('kpi anchor integration database was not initialized');
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
  const marker = `kpi-anchor-${randomUUID()}`;
  await sql()`
    INSERT INTO reviews (
      id, business_id, provider, provider_review_id, provider_review_name,
      provider_location_name, reviewer_name, star_rating, review_text,
      sentiment_score, review_date, detected_at, status
    ) VALUES (
      ${reviewId}::uuid, ${bizId}::uuid, 'zernio',
      ${marker}, ${`zernio://kpi-anchor/reviews/${marker}`},
      'zernio://kpi-anchor/locations/1', 'KPI Anchor Customer',
      ${spec.star}, 'KPI anchor fixture review',
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

describeWithDb('KPI review-time anchor semantics against live Postgres', { timeout: 30_000 }, () => {
  beforeAll(async () => {
    db = postgres(testDatabaseUrl!, { max: 1, prepare: false });
    // #688 ships NO migration of its own. Every column this suite touches
    // (review_date/detected_at/sentiment_score, responses.approved_at)
    // predates 071, so the run-spine floor is a valid head proxy — a
    // behind-head container fails loudly with the actionable
    // `pnpm test:db:setup` message instead of a confusing assertion failure.
    await assertSchemaReady(db, [MIGRATION_071_RUN_SPINE]);
    tenant = await seedTenantAccount(db, {
      userName: 'KPI Anchor Owner',
      accountDisplayName: 'KPI Anchor Account',
    });
    for (const [bizId, name] of [
      [VOLUME_BIZ, 'Volume'],
      [TREND_BIZ, 'Trend'],
      [STAR_BIZ, 'Star'],
      [NULLFB_BIZ, 'Null Fallback'],
      [FUTURE_BIZ, 'Future'],
      [RATE_BIZ, 'Rate'],
      [TTR_BIZ, 'TTR'],
    ] as const) {
      await seedLocation(db, tenant.accountId, {
        businessId: bizId,
        name: `KPI Anchor ${name} Location`,
        // businesses_account_primary_uniq permits ONE primary per account;
        // seedLocation defaults isPrimary true, so only the first cluster is.
        isPrimary: bizId === VOLUME_BIZ,
      });
    }

    // Test 1 — a Review import whose review_date is ALWAYS in the prior
    // calendar month (every month has ≥ 28 days > 10), stored today.
    await seedReview(VOLUME_BIZ, {
      star: 3,
      reviewDate: sql()`DATE_TRUNC('month', NOW()) - interval '10 days'`,
      detectedAt: sql()`NOW()`,
    });

    // Test 2 — a Review import written three weeks back (Monday-aligned so
    // the expected trend bucket is exact), stored today.
    await seedReview(TREND_BIZ, {
      star: 4,
      sentimentScore: 0.8,
      reviewDate: sql()`DATE_TRUNC('week', NOW()) - interval '21 days'`,
      detectedAt: sql()`NOW()`,
    });

    // Test 3 — one 1★ import far outside the 30d review-time window beside
    // one organic in-window 5★ review.
    await seedReview(STAR_BIZ, {
      star: 1,
      reviewDate: sql()`NOW() - interval '60 days'`,
      detectedAt: sql()`NOW()`,
    });
    await seedReview(STAR_BIZ, {
      star: 5,
      reviewDate: sql()`NOW() - interval '1 day'`,
      detectedAt: sql()`NOW() - interval '1 day'`,
    });

    // Test 4 — no review_date at all: the Review-time anchor must fall back
    // to detected_at (Postgres LEAST ignores NULLs).
    await seedReview(NULLFB_BIZ, {
      star: 4,
      reviewDate: null,
      detectedAt: sql()`NOW()`,
    });

    // Test 5 — provider clock skew: a FUTURE review_date. The Review-time
    // anchor clamps it to detected_at; a naive COALESCE(review_date,
    // detected_at) would bucket it into a week the trend's generate_series
    // LEFT JOIN never emits, silently vanishing it.
    await seedReview(FUTURE_BIZ, {
      star: 3,
      sentimentScore: 0.5,
      reviewDate: sql()`NOW() + interval '2 days'`,
      detectedAt: sql()`NOW()`,
    });

    // Test 6 — an imported UNANSWERED review: ancient review_date, stored
    // today. Response rate deliberately stays on detected_at, so it counts.
    await seedReview(RATE_BIZ, {
      star: 2,
      reviewDate: sql()`NOW() - interval '200 days'`,
      detectedAt: sql()`NOW()`,
    });

    // Test 8 — review H: organic review answered 6 hours after detection.
    // Test 7's review G (the pre-existing-reply negative sample) is seeded
    // INSIDE its own test — see the declaration-order note above it.
    const reviewH = await seedReview(TTR_BIZ, {
      star: 5,
      reviewDate: sql()`NOW() - interval '10 hours'`,
      detectedAt: sql()`NOW() - interval '10 hours'`,
    });
    await seedPostedResponse(reviewH, TTR_BIZ, sql()`NOW() - interval '4 hours'`);
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

  it('volume MoM buckets an imported review into its review_date month, not the import month', async () => {
    const summary = await getLocationKpiSummary(sql(), VOLUME_BIZ);
    // Review-time anchor semantics: the import belongs to its review_date
    // month (always the prior calendar month here), NOT the import month.
    expect(summary.reviewVolume.priorMonth).toBe(1);
    expect(summary.reviewVolume.currentMonth).toBe(0);
  });

  it('sentiment trend buckets an imported review into its review_date week, not the import week', async () => {
    // Expected week starts computed in SQL — selected as ::date (NOT ::text)
    // so they round-trip through the SAME postgres.js decode + String() path
    // mapTrend uses for week_start. postgres.js decodes a `date` column into
    // a JS Date, so String() yields the long local form, not ISO — a ::text
    // expectation would never match any trend point.
    const [weeks] = await sql()<{ import_week: unknown; current_week: unknown }[]>`
      SELECT (DATE_TRUNC('week', NOW()) - interval '21 days')::date AS import_week,
             DATE_TRUNC('week', NOW())::date AS current_week
    `;
    const importWeek = String(weeks!.import_week);
    const currentWeek = String(weeks!.current_week);

    const summary = await getLocationKpiSummary(sql(), TREND_BIZ);
    const importPoint = summary.sentimentTrend.find((p) => p.weekStart === importWeek);
    const currentPoint = summary.sentimentTrend.find((p) => p.weekStart === currentWeek);
    expect(importPoint).toBeDefined();
    expect(currentPoint).toBeDefined();
    // Review-time anchor: the import counts in its review_date week…
    expect(importPoint!.reviewCount).toBe(1);
    // …and NOT in the week the Review import ran.
    expect(currentPoint!.reviewCount).toBe(0);
  });

  it('avg star window excludes a review whose review_date is outside the window even though detected_at is inside', async () => {
    const summary = await getLocationKpiSummary(sql(), STAR_BIZ);
    // Only the in-window 5★ review may contribute: the 1★ import's
    // Review-time anchor (review_date, 60 days back) is outside the 30d
    // window even though its detected_at (today) is inside.
    expect(summary.averageStarRating).toBe(5);
  });

  it('review-time anchor falls back to detected_at when review_date is NULL', async () => {
    const summary = await getLocationKpiSummary(sql(), NULLFB_BIZ);
    // Regression pin (green before AND after #688): LEAST ignores NULLs, so a
    // NULL review_date keeps anchoring on detected_at — the row stays in the
    // star window and in the current volume month.
    expect(summary.averageStarRating).toBe(4);
    expect(summary.reviewVolume.currentMonth).toBe(1);
  });

  it('review-time anchor clamps a future review_date to detected_at', async () => {
    const [weeks] = await sql()<{ current_week: unknown }[]>`
      SELECT DATE_TRUNC('week', NOW())::date AS current_week
    `;
    const currentWeek = String(weeks!.current_week);

    const summary = await getLocationKpiSummary(sql(), FUTURE_BIZ);
    // Regression pin: the clock-skewed row must land in the CURRENT week (its
    // detected_at), and must not vanish from the series — the failure mode of
    // an unclamped COALESCE under the generate_series LEFT JOIN.
    const currentPoint = summary.sentimentTrend.find((p) => p.weekStart === currentWeek);
    expect(currentPoint).toBeDefined();
    expect(currentPoint!.reviewCount).toBe(1);
    expect(summary.sentimentTrend.reduce((n, p) => n + p.reviewCount, 0)).toBe(1);
  });

  it('response rate still windows on detected_at so imported unanswered reviews drag the rate', async () => {
    const summary = await getLocationKpiSummary(sql(), RATE_BIZ);
    // Regression pin: response rate is a WORKFLOW KPI — deliberately anchored
    // on detected_at (#675 nudge reasoning). The 200-day-old imported review
    // was stored today, so it counts as received-and-unhandled NOW.
    expect(summary.responseRate).toEqual({ received: 1, handled: 0, ratePct: 0 });
  });

  // Declaration order deliberately puts test 8 (the pin) BEFORE test 7 (the
  // red probe): test 7 seeds the pre-existing-reply pair into the same
  // TTR_BIZ, and the pin must read the summary while only review H exists —
  // the plan's "seed order makes 7+8 assert the same summary". After Task 3
  // both pass against the same final state: G is excluded, H's 6.0h remains.
  it("time-to-respond keeps a response whose approved_at follows its review's detected_at", async () => {
    const summary = await getLocationKpiSummary(sql(), TTR_BIZ);
    // Review H: detected 10h ago, approved 4h ago → 6.0h owner latency.
    expect(summary.averageTimeToRespondHours).toBe(6);
  });

  it("time-to-respond excludes a response whose approved_at predates its review's detected_at", async () => {
    // Review G — a Review import carrying a pre-existing Google reply whose
    // ORIGINAL timestamp (approved_at, 10 days ago) is INSIDE the 30d
    // approved_at window but BEFORE the review's detected_at (1 day ago) —
    // the bounded in-window negative case measured on staging. A negative
    // duration is never our response latency.
    const reviewG = await seedReview(TTR_BIZ, {
      star: 4,
      reviewDate: sql()`NOW() - interval '12 days'`,
      detectedAt: sql()`NOW() - interval '1 day'`,
    });
    await seedPostedResponse(reviewG, TTR_BIZ, sql()`NOW() - interval '10 days'`);

    const summary = await getLocationKpiSummary(sql(), TTR_BIZ);
    // G contributes nothing; only H's 6.0h remains.
    expect(summary.averageTimeToRespondHours).toBe(6);
  });

  // Supplementary (NOT in the promised list): account scope must aggregate
  // the same anchor-sensitive buckets the per-location summaries produce —
  // whichever anchor the code currently implements. Bucket-level equality
  // holds under detected_at today and under the Review-time anchor after
  // #688, but breaks if Task 2 ever lands the anchor in ONE scope only.
  it('account scope applies the same review-time anchor', async () => {
    const account = await getAccountKpiSummary(sql(), tenant!.accountId);
    const locations: DashboardKpiSummary[] = [];
    for (const bizId of ALL_BIZ) {
      locations.push(await getLocationKpiSummary(sql(), bizId));
    }
    const sum = (pick: (s: DashboardKpiSummary) => number) =>
      locations.reduce((n, s) => n + pick(s), 0);

    expect(account.reviewVolume.currentMonth).toBe(sum((s) => s.reviewVolume.currentMonth));
    expect(account.reviewVolume.priorMonth).toBe(sum((s) => s.reviewVolume.priorMonth));
    expect(account.responseRate.received).toBe(sum((s) => s.responseRate.received));
    expect(account.responseRate.handled).toBe(sum((s) => s.responseRate.handled));
    // Trend: identical week buckets, each week's count = sum of the locations'.
    expect(account.sentimentTrend.map((p) => p.weekStart)).toEqual(
      locations[0]!.sentimentTrend.map((p) => p.weekStart),
    );
    account.sentimentTrend.forEach((point, i) => {
      expect(point.reviewCount).toBe(sum((s) => s.sentimentTrend[i]!.reviewCount));
    });
  });
});
