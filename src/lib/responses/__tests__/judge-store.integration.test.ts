import { afterAll, beforeAll, expect, it } from 'vitest';
import postgres from 'postgres';
import type postgresType from 'postgres';
import { randomUUID } from 'node:crypto';
import { describeWithDb } from '@/__tests__/helpers/describe-with-db';
import {
  cleanupTenantAccount,
  seedTenantAccount,
  type TenantSeed,
} from '@/lib/shared/__tests__/live-db-tenant';
import { anchorReviewLockOrder } from '@/lib/approval/outcomes';
import { SubscriptionStatus } from '@/lib/shared/subscription-status';
import { QUEUE_NAMES } from '@/lib/shared/queue-names';
import {
  insertJudgeVerdict,
  listUnjudgedAutoPosts,
  type InsertJudgeVerdictInput,
} from '../judge-store';

const LOCAL_TEST_DATABASE_URL = 'postgresql://test:test@localhost:5499/test_ws4';
const testDatabaseUrl = process.env.TEST_DATABASE_POOL_URL;

let db: postgresType.Sql | undefined;
let activeTenant: TenantSeed | undefined;
let cancelledTenant: TenantSeed | undefined;

const activeBusinessId = randomUUID();
const cancelledBusinessId = randomUUID();
const eligibleReviewId = randomUUID();
const eligibleResponseId = randomUUID();
const judgedReviewId = randomUUID();
const judgedResponseId = randomUUID();
const inflightReviewId = randomUUID();
const inflightResponseId = randomUUID();
const dedupReviewId = randomUUID();
const dedupResponseId = randomUUID();
const cancelledReviewId = randomUUID();
const cancelledResponseId = randomUUID();
const inflightOutboxId = randomUUID();

function sql(): postgresType.Sql {
  if (!db) throw new Error('judge-store integration database was not initialized');
  return db;
}

function requireActiveTenant(): TenantSeed {
  if (!activeTenant) throw new Error('judge-store active tenant was not seeded');
  return activeTenant;
}

function assertExactLocalDatabaseUrl(databaseUrl: string | undefined): string {
  if (databaseUrl !== LOCAL_TEST_DATABASE_URL) {
    throw new Error('judge-store integration requires the exact local test_ws4 database');
  }
  return databaseUrl;
}

function verdictInput(responseId: string, reviewId: string): InsertJudgeVerdictInput {
  return {
    accountId: requireActiveTenant().accountId,
    businessId: activeBusinessId,
    reviewId,
    responseId,
    agentRunId: null,
    verdict: 'pass',
    reasons: [],
    rationale: 'Safe and appropriate.',
    model: 'gpt-4o-mini-2024-07-18',
    promptVersion: '2026-07-13.1',
  };
}

async function insertAnchoredVerdict(responseId: string, reviewId: string) {
  return sql().begin(async (tx) => {
    const anchoredReviewId = await anchorReviewLockOrder(tx, responseId, activeBusinessId);
    expect(anchoredReviewId).toBe(reviewId);
    return insertJudgeVerdict(tx, verdictInput(responseId, reviewId));
  });
}

describeWithDb('judge verdict store against live local Postgres', { timeout: 30_000 }, () => {
  beforeAll(async () => {
    db = postgres(assertExactLocalDatabaseUrl(testDatabaseUrl), { max: 1, prepare: false });
    activeTenant = await seedTenantAccount(db, {
      userName: 'Judge Store Active Owner',
      accountDisplayName: 'Judge Store Active Account',
      subscriptionStatus: SubscriptionStatus.ACTIVE,
    });
    cancelledTenant = await seedTenantAccount(db, {
      userName: 'Judge Store Cancelled Owner',
      accountDisplayName: 'Judge Store Cancelled Account',
      subscriptionStatus: SubscriptionStatus.CANCELLED,
    });

    await db`
      INSERT INTO businesses (id, name, owner_name, owner_email, account_id, subscription_status)
      VALUES
        (${activeBusinessId}::uuid, 'Judge Store Active Biz', 'Active Owner', ${activeTenant.ownerEmail}, ${activeTenant.accountId}::uuid, ${SubscriptionStatus.ACTIVE}),
        (${cancelledBusinessId}::uuid, 'Judge Store Cancelled Biz', 'Cancelled Owner', ${cancelledTenant.ownerEmail}, ${cancelledTenant.accountId}::uuid, ${SubscriptionStatus.CANCELLED})
    `;
    await db`
      INSERT INTO reviews (
        id, business_id, provider, provider_review_id, provider_review_name,
        provider_location_name, reviewer_name, star_rating, review_text, status
      ) VALUES
        (${eligibleReviewId}::uuid, ${activeBusinessId}::uuid, 'zernio', ${`judge-${eligibleReviewId}`}, ${`zernio://judge/reviews/${eligibleReviewId}`}, 'zernio://judge/locations/active', 'Eligible Reviewer', 5, 'Excellent service.', 'posted'),
        (${judgedReviewId}::uuid, ${activeBusinessId}::uuid, 'zernio', ${`judge-${judgedReviewId}`}, ${`zernio://judge/reviews/${judgedReviewId}`}, 'zernio://judge/locations/active', 'Judged Reviewer', 5, 'Excellent service.', 'posted'),
        (${inflightReviewId}::uuid, ${activeBusinessId}::uuid, 'zernio', ${`judge-${inflightReviewId}`}, ${`zernio://judge/reviews/${inflightReviewId}`}, 'zernio://judge/locations/active', 'Inflight Reviewer', 5, 'Excellent service.', 'posted'),
        (${dedupReviewId}::uuid, ${activeBusinessId}::uuid, 'zernio', ${`judge-${dedupReviewId}`}, ${`zernio://judge/reviews/${dedupReviewId}`}, 'zernio://judge/locations/active', 'Dedup Reviewer', 5, 'Excellent service.', 'posted'),
        (${cancelledReviewId}::uuid, ${cancelledBusinessId}::uuid, 'zernio', ${`judge-${cancelledReviewId}`}, ${`zernio://judge/reviews/${cancelledReviewId}`}, 'zernio://judge/locations/cancelled', 'Cancelled Reviewer', 5, 'Excellent service.', 'posted')
    `;
    await db`
      INSERT INTO responses (
        id, review_id, business_id, response_text, original_draft_text,
        version, status, approval_method, posted_at
      ) VALUES
        (${eligibleResponseId}::uuid, ${eligibleReviewId}::uuid, ${activeBusinessId}::uuid, 'Thank you!', 'Thank you!', 1, 'posted', 'auto_policy', NOW() - INTERVAL '5 minutes'),
        (${judgedResponseId}::uuid, ${judgedReviewId}::uuid, ${activeBusinessId}::uuid, 'Thank you!', 'Thank you!', 1, 'posted', 'auto_policy', NOW() - INTERVAL '10 minutes'),
        (${inflightResponseId}::uuid, ${inflightReviewId}::uuid, ${activeBusinessId}::uuid, 'Thank you!', 'Thank you!', 1, 'posted', 'auto_policy', NOW() - INTERVAL '15 minutes'),
        (${dedupResponseId}::uuid, ${dedupReviewId}::uuid, ${activeBusinessId}::uuid, 'Thank you!', 'Thank you!', 1, 'posted', 'auto_policy', NOW() - INTERVAL '48 hours'),
        (${cancelledResponseId}::uuid, ${cancelledReviewId}::uuid, ${cancelledBusinessId}::uuid, 'Thank you!', 'Thank you!', 1, 'posted', 'auto_policy', NOW() - INTERVAL '20 minutes')
    `;

    await insertAnchoredVerdict(judgedResponseId, judgedReviewId);
    await db`
      INSERT INTO job_outbox (id, topic, aggregate_type, aggregate_id, payload, status)
      VALUES (
        ${inflightOutboxId}::uuid, ${QUEUE_NAMES.JUDGE_VERDICT}, 'response',
        ${inflightResponseId}::uuid,
        ${db.json({ response_id: inflightResponseId, business_id: activeBusinessId })},
        'pending'
      )
    `;
  });

  afterAll(async () => {
    if (!db) return;
    await sql()`DELETE FROM job_outbox WHERE id = ${inflightOutboxId}::uuid`;
    await sql()`DELETE FROM judge_verdicts WHERE business_id IN (${activeBusinessId}::uuid, ${cancelledBusinessId}::uuid)`;
    await sql()`DELETE FROM responses WHERE business_id IN (${activeBusinessId}::uuid, ${cancelledBusinessId}::uuid)`;
    await sql()`DELETE FROM reviews WHERE business_id IN (${activeBusinessId}::uuid, ${cancelledBusinessId}::uuid)`;
    await sql()`DELETE FROM businesses WHERE id IN (${activeBusinessId}::uuid, ${cancelledBusinessId}::uuid)`;
    if (activeTenant) await cleanupTenantAccount(sql(), activeTenant);
    if (cancelledTenant) await cleanupTenantAccount(sql(), cancelledTenant);
    await db.end({ timeout: 5 });
  });

  it('absorbs a repeated verdict insert for the same response', async () => {
    const first = await insertAnchoredVerdict(dedupResponseId, dedupReviewId);
    const replay = await insertAnchoredVerdict(dedupResponseId, dedupReviewId);

    expect(first).toEqual({ inserted: true });
    expect(replay).toEqual({ inserted: false });
    const rows = await sql()<{ count: number }[]>`
      SELECT COUNT(*)::int AS count FROM judge_verdicts
      WHERE response_id = ${dedupResponseId}::uuid
    `;
    expect(rows[0]!.count).toBe(1);
  });

  it('returns only the eligible row, excluding judged, in-flight, and cancelled rows', async () => {
    const candidates = await listUnjudgedAutoPosts(sql(), { lookbackHours: 24, limit: 50 });
    const responseIds = candidates.map((row) => row.response_id);

    expect(responseIds).toContain(eligibleResponseId);
    expect(responseIds).not.toContain(judgedResponseId);
    expect(responseIds).not.toContain(inflightResponseId);
    expect(responseIds).not.toContain(cancelledResponseId);
  });
});
