// Real-Postgres behavioral suite for the content-freshness gate (ADR 0017) at
// the persist boundary of response generation — the STALE-CONTENT direction
// that #678's race test does NOT cover: there the fresh job persists first and
// the stale job dies on the unique (review_id, version) slot; here the stale
// job reaches the persist boundary FIRST and must skip-the-INSERT with zero
// writes, leaving the (review_id, version) slot free for the colliding fresh
// job. The lock-serialization test is the discriminating one: an
// implementation that reads the hash BEFORE taking the review FOR UPDATE lock
// passes every mocked test and still persists stale here.
//
// Executes NO DDL at run time: the schema comes provisioned from
// `pnpm test:db:setup`; every table this suite touches predates the gate.
//
// Harness mirrors auto-approval-daily-cap.integration.test.ts: describeWithDb,
// seedTenantAccount/cleanupTenantAccount, and TWO postgres clients (one
// connection each) — the lock-serialization test needs genuinely concurrent
// transactions. No migration-074 helper: the on_demand_generate lane is a
// structural non-candidate and never reads 074 columns. Each test arranges its
// own review row (distinct reviewId per test) — no cross-test state
// dependence.

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
import { GENERATE_RESPONSE_ORIGIN_LANE } from '@/lib/shared/worker-types';
import { persistResponseAndNotify, type PersistResponseInput } from '../persist';

const testDatabaseUrl = process.env.TEST_DATABASE_POOL_URL;

// Two clients (one connection each): the lock-serialization test needs two
// GENUINELY concurrent transactions, which a single max-1 pool cannot give.
let dbA: postgresType.Sql | undefined;
let dbB: postgresType.Sql | undefined;
let tenant: TenantSeed | undefined;
const businessId = randomUUID();
const reviewId = randomUUID(); // stale-content direction test
const reviewId2 = randomUUID(); // slot-free test
const reviewId3 = randomUUID(); // lock-serialization test
const runId = randomUUID(); // ACTIVE agent_runs row for reviewId
const costId = randomUUID(); // real api_costs row linked as input apiCostId

function sqlA(): postgresType.Sql {
  if (!dbA) throw new Error('content-freshness gate integration database A was not initialized');
  return dbA;
}

function sqlB(): postgresType.Sql {
  if (!dbB) throw new Error('content-freshness gate integration database B was not initialized');
  return dbB;
}

function accountId(): string {
  if (!tenant) throw new Error('content-freshness gate integration tenant was not seeded');
  return tenant.accountId;
}

function delay(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

async function seedReview(db: postgresType.Sql, id: string, label: string): Promise<void> {
  await db`
    INSERT INTO reviews (id, business_id, provider, provider_review_id, provider_review_name, provider_location_name, reviewer_name, star_rating, review_text, status)
    VALUES (${id}::uuid, ${businessId}::uuid, 'zernio', ${`fresh-${id}`}, ${`zernio://fresh/reviews/${id}`}, 'zernio://fresh/locations/1', ${label}, 5, 'Great place, will return.', 'pending')
  `;
}

interface GateInputOverrides {
  loadedReviewContentHash: string | null;
  apiCostId?: string | null;
}

/**
 * Persist input on the on_demand_generate lane (structural auto-approval
 * non-candidate): clean moderation, version 1, notification NOT suppressed,
 * no-op logger. apiCostId null everywhere except the stale-content direction
 * test, which links the real seeded api_costs row.
 */
function makeInput(forReviewId: string, overrides: GateInputOverrides): PersistResponseInput {
  return {
    result: {
      responseText: 'Thanks for the kind review!',
      language: 'en',
      provider: 'openai',
      model: 'gpt-4o-mini-2024-07-18',
      usage: { promptTokens: 10, completionTokens: 5 },
      costUsd: 0.0001,
      apiCostId: overrides.apiCostId ?? null,
    },
    reviewId: forReviewId,
    businessId,
    version: 1,
    correlationId: 'freshness-gate-int',
    suppressNotification: false,
    originLane: GENERATE_RESPONSE_ORIGIN_LANE.ON_DEMAND_GENERATE,
    loadedReviewContentHash: overrides.loadedReviewContentHash,
    moderation: {
      flagged: false,
      severity: 'low' as const,
      reason: null,
      categories: {},
      score: 0,
      source: 'openai_moderation' as const,
      providerStatus: 'clean' as const,
    },
    accountId: accountId(),
    preLlmSubscriptionTier: 'copilot',
    logger: { log: () => {}, warn: () => {} },
  };
}

const input = (overrides: GateInputOverrides) => makeInput(reviewId, overrides);
const input2 = (overrides: GateInputOverrides) => makeInput(reviewId2, overrides);
const input3 = (overrides: GateInputOverrides) => makeInput(reviewId3, overrides);

describeWithDb('content-freshness gate at the persist boundary (live Postgres)', { timeout: 30_000 }, () => {
  beforeAll(async () => {
    dbA = postgres(testDatabaseUrl!, { max: 1, prepare: false });
    dbB = postgres(testDatabaseUrl!, { max: 1, prepare: false });
    tenant = await seedTenantAccount(dbA, {
      userName: 'Freshness Gate Owner',
      accountDisplayName: 'Freshness Gate Account',
    });
    await dbA`
      INSERT INTO businesses (id, name, owner_name, owner_email, account_id, subscription_status)
      VALUES (${businessId}::uuid, 'Freshness Gate Biz', 'Freshness Gate Owner', ${tenant.ownerEmail}, ${tenant.accountId}::uuid, 'active')
    `;
    await seedReview(dbA, reviewId, 'Fresh Reviewer A');
    await seedReview(dbA, reviewId2, 'Fresh Reviewer B');
    await seedReview(dbA, reviewId3, 'Fresh Reviewer C');
    // Every review starts at the hash the worker "loaded" pre-LLM; each test
    // moves its OWN review's current hash to arrange its scenario.
    await dbA`
      UPDATE reviews
      SET review_content_hash = 'hash-loaded'
      WHERE id IN (${reviewId}::uuid, ${reviewId2}::uuid, ${reviewId3}::uuid)
    `;
    // Real api_costs row (column list cribbed from src/lib/costs/audit.ts's
    // recordApiCost INSERT) so a partial cost-link write cannot hide behind a
    // null apiCostId input.
    await dbA`
      INSERT INTO api_costs (
        id, business_id, account_id, provider, endpoint,
        input_tokens, output_tokens, cost_usd, response_id
      ) VALUES (
        ${costId}::uuid, ${businessId}::uuid, ${tenant.accountId}::uuid, 'openai', 'chat.completions',
        10, 5, 0.0001, NULL
      )
    `;
    // ACTIVE run-spine row for the stale-content direction test (column list
    // cribbed from the run-spine live fixtures) so a partial spine write
    // cannot hide behind a missing run.
    await dbA`
      INSERT INTO agent_runs (id, account_id, business_id, kind, subject_type, subject_id, status)
      VALUES (${runId}::uuid, ${tenant.accountId}::uuid, ${businessId}::uuid, 'review_handler', 'review', ${reviewId}::uuid, 'running')
    `;
  });

  afterAll(async () => {
    if (dbB) await dbB.end({ timeout: 5 });
    if (!dbA) return;
    if (tenant) {
      await sqlA()`DELETE FROM agent_run_steps WHERE run_id = ${runId}::uuid`;
      await sqlA()`DELETE FROM agent_outcomes WHERE run_id = ${runId}::uuid`;
      await sqlA()`DELETE FROM agent_runs WHERE id = ${runId}::uuid`;
      await sqlA()`DELETE FROM job_outbox WHERE payload->>'business_id' = ${businessId}`;
      await sqlA()`DELETE FROM api_costs WHERE id = ${costId}::uuid`;
      await sqlA()`DELETE FROM responses WHERE business_id = ${businessId}::uuid`;
      await sqlA()`DELETE FROM reviews WHERE id IN (${reviewId}::uuid, ${reviewId2}::uuid, ${reviewId3}::uuid)`;
      await sqlA()`DELETE FROM businesses WHERE id = ${businessId}::uuid`;
      await cleanupTenantAccount(sqlA(), tenant);
    }
    await dbA.end({ timeout: 5 });
  });

  it('persist gate skips the INSERT when review content changed after load (stale-content direction)', async () => {
    // Own review seeded with review_content_hash 'hash-loaded', PLUS a real
    // api_costs row (input apiCostId = its id) and an ACTIVE agent_runs row
    // for the review — so a partial write (cost link, spine step) cannot hide
    // behind null inputs (codex finding).
    await sqlA()`UPDATE reviews SET review_content_hash = 'hash-current', review_text = 'edited text' WHERE id = ${reviewId}::uuid`;
    const outboxBefore = await sqlA()<{ n: number }[]>`
      SELECT count(*)::int AS n FROM job_outbox
      WHERE topic = 'send_notification' AND payload->>'business_id' = ${businessId}
    `;

    const outcome = await persistResponseAndNotify(sqlA(), input({ loadedReviewContentHash: 'hash-loaded', apiCostId: costId }));

    expect(outcome).toEqual({ kind: 'skipped_stale_content' });
    expect(await sqlA()`SELECT id FROM responses WHERE review_id = ${reviewId}::uuid`).toHaveLength(0);
    const [cost] = await sqlA()<{ response_id: string | null; flagged: boolean }[]>`
      SELECT response_id, flagged FROM api_costs WHERE id = ${costId}::uuid
    `;
    expect(cost!.response_id).toBeNull(); // no cost link, no moderation metadata write
    expect(cost!.flagged).toBe(false);
    expect(await sqlA()`SELECT id FROM agent_run_steps WHERE run_id = ${runId}::uuid`).toHaveLength(0);
    expect(await sqlA()`SELECT id FROM agent_outcomes WHERE run_id = ${runId}::uuid`).toHaveLength(0);
    // The run must STILL be running after the skip — a gate that
    // completes/fails the run would strand the colliding fresh job's spine.
    const [run] = await sqlA()<{ status: string }[]>`SELECT status FROM agent_runs WHERE id = ${runId}::uuid`;
    expect(run!.status).toBe('running');
    // send_notification payloads carry response_id/business_id, NOT review_id
    // — baseline diff, not a review_id filter (codex finding).
    const outboxAfter = await sqlA()<{ n: number }[]>`
      SELECT count(*)::int AS n FROM job_outbox
      WHERE topic = 'send_notification' AND payload->>'business_id' = ${businessId}
    `;
    expect(outboxAfter[0]!.n).toBe(outboxBefore[0]!.n);
  });

  it('persist gate leaves the (review_id, version) slot free for the colliding fresh job', async () => {
    // Own review; first a skip (loaded 'hash-loaded' vs current
    // 'hash-current'), then a fresh persist at the SAME version with the
    // MATCHING current hash must succeed — no unique violation:
    // skip-the-INSERT left the slot free.
    await sqlA()`UPDATE reviews SET review_content_hash = 'hash-current' WHERE id = ${reviewId2}::uuid`;
    await persistResponseAndNotify(sqlA(), input2({ loadedReviewContentHash: 'hash-loaded' }));
    const outcome = await persistResponseAndNotify(sqlA(), input2({ loadedReviewContentHash: 'hash-current' }));
    expect(outcome).toEqual(expect.objectContaining({ kind: 'persisted' }));
    const rows = await sqlA()<{ version: number }[]>`SELECT version FROM responses WHERE review_id = ${reviewId2}::uuid`;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ version: 1 });
  });

  it('persist gate re-reads review_content_hash under the review FOR UPDATE lock (blocks on a concurrent content-change tx, then skips)', { timeout: 10_000 }, async () => {
    // The discriminating test (codex finding): an implementation that reads
    // the hash BEFORE taking the lock sees the still-committed 'hash-loaded',
    // matches, blocks on B's row lock, then persists stale after B commits.
    // Client B: open a tx holding the review row lock with the content change
    // uncommitted. Round-2 finding #2: await proof B's UPDATE holds the row
    // lock BEFORE starting A — otherwise A can win the lock first,
    // legitimately persist (hash still matches), and the test fails
    // intermittently.
    let signalLockAcquired!: () => void;
    const lockAcquired = new Promise<void>((resolve) => { signalLockAcquired = resolve; });
    let resolveReleaseGate!: () => void;
    const releaseGate = new Promise<void>((resolve) => { resolveReleaseGate = resolve; });
    const bDone = sqlB().begin(async (txB) => {
      await txB`UPDATE reviews SET review_content_hash = 'hash-current' WHERE id = ${reviewId3}::uuid`;
      signalLockAcquired(); // UPDATE returned → B holds the row lock
      await releaseGate; // resolved after the test asserts A blocks
    });
    await lockAcquired;
    // Client A: persist with the stale loaded hash — must BLOCK on the FOR UPDATE.
    const aPending = persistResponseAndNotify(sqlA(), input3({ loadedReviewContentHash: 'hash-loaded' }));
    try {
      const raced = await Promise.race([aPending.then(() => 'resolved'), delay(250).then(() => 'blocked')]);
      expect(raced).toBe('blocked');
    } finally {
      // Always release B — a failed assertion must not leave its open tx
      // holding the review row lock and wedge afterAll's cleanup DELETEs.
      resolveReleaseGate();
      await bDone; // B commits the content change
    }
    const outcome = await aPending; // A re-reads under the lock → sees 'hash-current' → skips
    expect(outcome).toEqual({ kind: 'skipped_stale_content' });
    expect(await sqlA()`SELECT id FROM responses WHERE review_id = ${reviewId3}::uuid`).toHaveLength(0);
  });
});
