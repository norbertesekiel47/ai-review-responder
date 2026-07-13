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
import { checkSubscription } from '@/lib/shared/subscription-guard';
import { publisherSubscriptionEligibleSql } from '@/lib/shared/subscription-eligibility-sql';
import { QUEUE_NAMES } from '@/lib/shared/queue-names';
import {
  insertJudgeVerdict,
  listUnjudgedAutoPosts,
  type InsertJudgeVerdictInput,
} from '../judge-store';
import { isJudgeHealthy } from '../judge-health';

const LOCAL_TEST_DATABASE_URL = 'postgresql://test:test@localhost:5499/test_ws4';
const testDatabaseUrl = process.env.TEST_DATABASE_POOL_URL;

let db: postgresType.Sql | undefined;
let activeTenant: TenantSeed | undefined;
let cancelledTenant: TenantSeed | undefined;
let graceTenant: TenantSeed | undefined;
let expiredTenant: TenantSeed | undefined;
let pendingTenant: TenantSeed | undefined;

const activeBusinessId = randomUUID();
const cancelledBusinessId = randomUUID();
const graceBusinessId = randomUUID();
const expiredBusinessId = randomUUID();
const pendingBusinessId = randomUUID();
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
const graceReviewId = randomUUID();
const graceResponseId = randomUUID();
const expiredReviewId = randomUUID();
const expiredResponseId = randomUUID();
const pendingReviewId = randomUUID();
const pendingResponseId = randomUUID();
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

async function sqlPublisherEligibilityPair(flags: postgresType.JSONValue): Promise<{
  target: boolean;
  companion: boolean;
}> {
  const client = sql();
  const rows = await client<{ label: string; eligible: boolean }[]>`
    SELECT a.label, ${publisherSubscriptionEligibleSql(client)} AS eligible
    FROM (
      SELECT
        'target'::text AS label,
        ${SubscriptionStatus.PAST_DUE}::text AS subscription_status,
        ${new Date('2020-01-01T00:00:00.000Z')}::timestamptz AS past_due_at,
        ${client.json(flags)} AS flags
      UNION ALL
      SELECT
        'companion'::text AS label,
        ${SubscriptionStatus.PAST_DUE}::text AS subscription_status,
        ${new Date('2020-01-01T00:00:00.000Z')}::timestamptz AS past_due_at,
        ${client.json({
          past_due_extension: { days: 7, expires_at: '2099-01-01T00:00:00.000Z' },
        })} AS flags
    ) a
  `;
  return {
    target: rows.find((row) => row.label === 'target')!.eligible,
    companion: rows.find((row) => row.label === 'companion')!.eligible,
  };
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
    graceTenant = await seedTenantAccount(db, {
      userName: 'Judge Store Grace Owner',
      accountDisplayName: 'Judge Store Grace Account',
      subscriptionStatus: SubscriptionStatus.PAST_DUE,
    });
    expiredTenant = await seedTenantAccount(db, {
      userName: 'Judge Store Expired Owner',
      accountDisplayName: 'Judge Store Expired Account',
      subscriptionStatus: SubscriptionStatus.PAST_DUE,
    });
    pendingTenant = await seedTenantAccount(db, {
      userName: 'Judge Store Pending Owner',
      accountDisplayName: 'Judge Store Pending Account',
      subscriptionStatus: SubscriptionStatus.PENDING_PAYMENT,
    });
    await db`
      UPDATE accounts
      SET past_due_at = CASE id
        WHEN ${graceTenant.accountId}::uuid THEN NOW() - INTERVAL '2 days'
        WHEN ${expiredTenant.accountId}::uuid THEN NOW() - INTERVAL '8 days'
      END,
      flags = CASE id
        WHEN ${expiredTenant.accountId}::uuid THEN ${db.json({
          past_due_extension: { days: 7, expires_at: '2099-02-30T12:00:00.000Z' },
        })}
        ELSE flags
      END
      WHERE id IN (${graceTenant.accountId}::uuid, ${expiredTenant.accountId}::uuid)
    `;

    await db`
      INSERT INTO businesses (id, name, owner_name, owner_email, account_id, subscription_status)
      VALUES
        (${activeBusinessId}::uuid, 'Judge Store Active Biz', 'Active Owner', ${activeTenant.ownerEmail}, ${activeTenant.accountId}::uuid, ${SubscriptionStatus.ACTIVE}),
        (${cancelledBusinessId}::uuid, 'Judge Store Cancelled Biz', 'Cancelled Owner', ${cancelledTenant.ownerEmail}, ${cancelledTenant.accountId}::uuid, ${SubscriptionStatus.CANCELLED}),
        (${graceBusinessId}::uuid, 'Judge Store Grace Biz', 'Grace Owner', ${graceTenant.ownerEmail}, ${graceTenant.accountId}::uuid, ${SubscriptionStatus.PAST_DUE}),
        (${expiredBusinessId}::uuid, 'Judge Store Expired Biz', 'Expired Owner', ${expiredTenant.ownerEmail}, ${expiredTenant.accountId}::uuid, ${SubscriptionStatus.PAST_DUE}),
        (${pendingBusinessId}::uuid, 'Judge Store Pending Biz', 'Pending Owner', ${pendingTenant.ownerEmail}, ${pendingTenant.accountId}::uuid, ${SubscriptionStatus.PENDING_PAYMENT})
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
        (${cancelledReviewId}::uuid, ${cancelledBusinessId}::uuid, 'zernio', ${`judge-${cancelledReviewId}`}, ${`zernio://judge/reviews/${cancelledReviewId}`}, 'zernio://judge/locations/cancelled', 'Cancelled Reviewer', 5, 'Excellent service.', 'posted'),
        (${graceReviewId}::uuid, ${graceBusinessId}::uuid, 'zernio', ${`judge-${graceReviewId}`}, ${`zernio://judge/reviews/${graceReviewId}`}, 'zernio://judge/locations/grace', 'Grace Reviewer', 5, 'Excellent service.', 'posted'),
        (${expiredReviewId}::uuid, ${expiredBusinessId}::uuid, 'zernio', ${`judge-${expiredReviewId}`}, ${`zernio://judge/reviews/${expiredReviewId}`}, 'zernio://judge/locations/expired', 'Expired Reviewer', 5, 'Excellent service.', 'posted'),
        (${pendingReviewId}::uuid, ${pendingBusinessId}::uuid, 'zernio', ${`judge-${pendingReviewId}`}, ${`zernio://judge/reviews/${pendingReviewId}`}, 'zernio://judge/locations/pending', 'Pending Reviewer', 5, 'Excellent service.', 'posted')
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
        (${cancelledResponseId}::uuid, ${cancelledReviewId}::uuid, ${cancelledBusinessId}::uuid, 'Thank you!', 'Thank you!', 1, 'posted', 'auto_policy', NOW() - INTERVAL '20 minutes'),
        (${graceResponseId}::uuid, ${graceReviewId}::uuid, ${graceBusinessId}::uuid, 'Thank you!', 'Thank you!', 1, 'posted', 'auto_policy', NOW() - INTERVAL '2 hours'),
        (${expiredResponseId}::uuid, ${expiredReviewId}::uuid, ${expiredBusinessId}::uuid, 'Thank you!', 'Thank you!', 1, 'posted', 'auto_policy', NOW() - INTERVAL '2 hours'),
        (${pendingResponseId}::uuid, ${pendingReviewId}::uuid, ${pendingBusinessId}::uuid, 'Thank you!', 'Thank you!', 1, 'posted', 'auto_policy', NOW() - INTERVAL '2 hours')
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
    await sql()`DELETE FROM judge_verdicts WHERE business_id IN (${activeBusinessId}::uuid, ${cancelledBusinessId}::uuid, ${graceBusinessId}::uuid, ${expiredBusinessId}::uuid, ${pendingBusinessId}::uuid)`;
    await sql()`DELETE FROM responses WHERE business_id IN (${activeBusinessId}::uuid, ${cancelledBusinessId}::uuid, ${graceBusinessId}::uuid, ${expiredBusinessId}::uuid, ${pendingBusinessId}::uuid)`;
    await sql()`DELETE FROM reviews WHERE business_id IN (${activeBusinessId}::uuid, ${cancelledBusinessId}::uuid, ${graceBusinessId}::uuid, ${expiredBusinessId}::uuid, ${pendingBusinessId}::uuid)`;
    await sql()`DELETE FROM businesses WHERE id IN (${activeBusinessId}::uuid, ${cancelledBusinessId}::uuid, ${graceBusinessId}::uuid, ${expiredBusinessId}::uuid, ${pendingBusinessId}::uuid)`;
    if (activeTenant) await cleanupTenantAccount(sql(), activeTenant);
    if (graceTenant) await cleanupTenantAccount(sql(), graceTenant);
    if (expiredTenant) await cleanupTenantAccount(sql(), expiredTenant);
    if (pendingTenant) await cleanupTenantAccount(sql(), pendingTenant);
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

  it('includes past-due grace while excluding judged, in-flight, cancelled, and expired-grace rows', async () => {
    const candidates = await listUnjudgedAutoPosts(sql(), { lookbackHours: 24, limit: 50 });
    const responseIds = candidates.map((row) => row.response_id);

    expect(responseIds).toContain(eligibleResponseId);
    expect(responseIds).toContain(graceResponseId);
    expect(responseIds).not.toContain(judgedResponseId);
    expect(responseIds).not.toContain(inflightResponseId);
    expect(responseIds).not.toContain(cancelledResponseId);
    expect(responseIds).not.toContain(expiredResponseId);
    expect(responseIds).not.toContain(pendingResponseId);
  });

  it('treats grace-period staleness as unhealthy but ignores expired past-due staleness', async () => {
    await expect(isJudgeHealthy(sql())).resolves.toBe(false);

    await sql().begin(async (tx) => {
      const anchored = await anchorReviewLockOrder(tx, graceResponseId, graceBusinessId);
      expect(anchored).toBe(graceReviewId);
      await insertJudgeVerdict(tx, {
        accountId: graceTenant!.accountId,
        businessId: graceBusinessId,
        reviewId: graceReviewId,
        responseId: graceResponseId,
        agentRunId: null,
        verdict: 'pass',
        reasons: [],
        rationale: 'Safe and appropriate.',
        model: 'gpt-4o-mini-2024-07-18',
        promptVersion: '2026-07-13.1',
      });
    });

    await expect(isJudgeHealthy(sql())).resolves.toBe(true);
  });

  it.each([
    ['canonical toISOString', { days: 7, expires_at: '2099-01-01T00:00:00.000Z' }, true],
    ['expired timestamp', { days: 7, expires_at: '2020-01-02T00:00:00.000Z' }, false],
    ['numeric offset +02', { days: 7, expires_at: '2099-01-01T02:00:00+02:00' }, false],
    ['numeric offset +15:59', { days: 7, expires_at: '2099-01-01T15:59:00+15:59' }, false],
    ['numeric offset +16', { days: 7, expires_at: '2099-01-01T16:00:00+16:00' }, false],
    ['date only', { days: 7, expires_at: '2099-01-01' }, false],
    ['missing fraction', { days: 7, expires_at: '2099-01-01T00:00:00Z' }, false],
    ['one fraction digit', { days: 7, expires_at: '2099-01-01T00:00:00.1Z' }, false],
    ['two fraction digits', { days: 7, expires_at: '2099-01-01T00:00:00.12Z' }, false],
    ['four fraction digits', { days: 7, expires_at: '2099-01-01T00:00:00.1234Z' }, false],
    ['six fraction digits', { days: 7, expires_at: '2099-01-01T00:00:00.123456Z' }, false],
    ['24 hour', { days: 7, expires_at: '2099-01-01T24:00:00.000Z' }, false],
    ['leap second', { days: 7, expires_at: '2099-01-01T00:00:60.000Z' }, false],
    ['impossible calendar', { days: 7, expires_at: '2099-02-30T00:00:00.000Z' }, false],
    ['non-leap February 29', { days: 7, expires_at: '2100-02-29T00:00:00.000Z' }, false],
    ['leap February 29', { days: 7, expires_at: '2096-02-29T00:00:00.000Z' }, true],
    ['string days', { days: '7', expires_at: '2099-01-01T00:00:00.000Z' }, false],
    ['garbage days', { days: 'garbage', expires_at: '2099-01-01T00:00:00.000Z' }, false],
    ['object days', { days: { value: 7 }, expires_at: '2099-01-01T00:00:00.000Z' }, false],
    ['array days', { days: [7], expires_at: '2099-01-01T00:00:00.000Z' }, false],
    ['null days', { days: null, expires_at: '2099-01-01T00:00:00.000Z' }, false],
    ['numeric expiry', { days: 7, expires_at: 4_071_004_800_000 }, false],
  ] as const)('keeps publisher SQL parity for %s', async (_label, extension, expected) => {
    const flags = { past_due_extension: extension };
    const canonical = checkSubscription({
      status: SubscriptionStatus.PAST_DUE,
      pastDueAt: new Date('2020-01-01T00:00:00.000Z'),
      accountFlags: flags,
      workerType: 'publisher',
    }).allowed;

    await expect(sqlPublisherEligibilityPair(flags)).resolves.toEqual({
      target: expected,
      companion: true,
    });
    expect(canonical).toBe(expected);
  });
});
