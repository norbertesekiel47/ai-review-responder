// Real-Postgres behavioral suite for the WS4 daily-cap accounting in
// loadAutoApprovalRuntimeState (spec §2.3): the unit suite only asserts SQL
// *text*; this drives the loader against live Postgres so the migration-074
// dial columns, the `businesses` FOR UPDATE serialization, and the UTC-day
// count execute for real. The serialization test is the strictness guarantee:
// two concurrent persist-shaped txs on ONE business must not both read a
// below-cap count (which would overshoot the cap).
//
// Gated on TEST_DATABASE_POOL_URL (skips cleanly without one). Migration 074
// is applied in beforeAll — fully idempotent, so this becomes a no-op once it
// ships to the shared test DB.

import { afterAll, beforeAll, expect, it } from 'vitest';
import postgres from 'postgres';
import type postgresType from 'postgres';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describeWithDb } from '@/__tests__/helpers/describe-with-db';
import {
  cleanupTenantAccount,
  seedTenantAccount,
  type TenantSeed,
} from '@/lib/shared/__tests__/live-db-tenant';
import { APPROVAL_METHOD } from '@/lib/auto-approval/types';
import { loadAutoApprovalRuntimeState } from '../auto-approval';

const testDatabaseUrl = process.env.TEST_DATABASE_POOL_URL;

// Two clients (one connection each): the serialization test needs two
// GENUINELY concurrent transactions, which a single max-1 pool cannot give.
let dbA: postgresType.Sql | undefined;
let dbB: postgresType.Sql | undefined;
let tenant: TenantSeed | undefined;
const businessId = randomUUID();
const reviewAId = randomUUID();
const reviewBId = randomUUID();
const policyId = randomUUID();

function sqlA(): postgresType.Sql {
  if (!dbA) throw new Error('daily-cap integration database A was not initialized');
  return dbA;
}

function sqlB(): postgresType.Sql {
  if (!dbB) throw new Error('daily-cap integration database B was not initialized');
  return dbB;
}

function accountId(): string {
  if (!tenant) throw new Error('daily-cap integration tenant was not seeded');
  return tenant.accountId;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolveFn!: () => void;
  const promise = new Promise<void>((res) => {
    resolveFn = res;
  });
  return { promise, resolve: resolveFn };
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

async function seedReview(db: postgresType.Sql, reviewId: string, label: string): Promise<void> {
  await db`
    INSERT INTO reviews (id, business_id, provider, provider_review_id, provider_review_name, provider_location_name, reviewer_name, star_rating, review_text, status)
    VALUES (${reviewId}::uuid, ${businessId}::uuid, 'zernio', ${`cap-${reviewId}`}, ${`zernio://cap/reviews/${reviewId}`}, 'zernio://cap/locations/1', ${label}, 5, 'Great place, will return.', 'pending')
  `;
}

async function insertAutoApprovedResponse(
  tx: postgresType.TransactionSql,
  reviewId: string,
): Promise<void> {
  await tx`
    INSERT INTO responses (id, review_id, business_id, response_text, original_draft_text, approved_text, version, status, approval_method, approved_at)
    VALUES (${randomUUID()}::uuid, ${reviewId}::uuid, ${businessId}::uuid, 'Thanks!', 'Thanks!', 'Thanks!', 1, 'approved', ${APPROVAL_METHOD.AUTO_POLICY}, NOW())
  `;
}

describeWithDb('WS4 daily-cap accounting in loadAutoApprovalRuntimeState against live Postgres', { timeout: 30_000 }, () => {
  beforeAll(async () => {
    dbA = postgres(testDatabaseUrl!, { max: 1, prepare: false });
    dbB = postgres(testDatabaseUrl!, { max: 1, prepare: false });
    await dbA.unsafe(
      readFileSync(resolve(process.cwd(), 'supabase/migrations', '074_trust_dial_veto_window.sql'), 'utf-8'),
    );
    tenant = await seedTenantAccount(dbA, {
      userName: 'Daily Cap Owner',
      accountDisplayName: 'Daily Cap Account',
    });
    await dbA`
      INSERT INTO businesses (id, name, owner_name, owner_email, account_id, subscription_status)
      VALUES (${businessId}::uuid, 'Daily Cap Biz', 'Daily Cap Owner', ${tenant.ownerEmail}, ${tenant.accountId}::uuid, 'active')
    `;
    await seedReview(dbA, reviewAId, 'Cap Reviewer A');
    await seedReview(dbA, reviewBId, 'Cap Reviewer B');
    // Account-default policy carrying non-default dial values so the loader's
    // column mapping is exercised against the real schema, not mocks.
    await dbA`
      INSERT INTO auto_approval_policies (id, account_id, location_id, auto_approve_min_star, veto_window_minutes, daily_auto_post_cap)
      VALUES (${policyId}::uuid, ${tenant.accountId}::uuid, NULL, 4, 30, 5)
    `;
  });

  afterAll(async () => {
    if (dbB) await dbB.end({ timeout: 5 });
    if (!dbA) return;
    if (tenant) {
      await sqlA()`DELETE FROM responses WHERE business_id = ${businessId}::uuid`;
      await sqlA()`DELETE FROM auto_approval_policies WHERE id = ${policyId}::uuid`;
      await sqlA()`DELETE FROM reviews WHERE id IN (${reviewAId}::uuid, ${reviewBId}::uuid)`;
      await sqlA()`DELETE FROM businesses WHERE id = ${businessId}::uuid`;
      await cleanupTenantAccount(sqlA(), tenant);
    }
    await dbA.end({ timeout: 5 });
  });

  it('loads the migration-074 dial columns and a zero count for a fresh location', async () => {
    const state = await sqlA().begin(async (tx) => {
      // Persist-shaped tx: review row FOR UPDATE first (lock-ordering contract).
      await tx`SELECT id FROM reviews WHERE id = ${reviewAId}::uuid AND business_id = ${businessId}::uuid FOR UPDATE`;
      return loadAutoApprovalRuntimeState(tx, {
        reviewId: reviewAId,
        businessId,
        accountId: accountId(),
      });
    });

    expect(state.effectivePolicy.source).toBe('account_default');
    expect(state.effectivePolicy.threshold).toBe(4);
    expect(state.effectivePolicy.vetoWindowMinutes).toBe(30);
    expect(state.effectivePolicy.dailyAutoPostCap).toBe(5);
    expect(state.effectivePolicy.suspended).toBe(false);
    expect(state.policySuspended).toBe(false);
    expect(state.effectiveDailyCap).toBe(5);
    expect(state.autoApprovedTodayCount).toBe(0);
  });

  it('serializes two concurrent persist-shaped txs on the business lock; the second counts the first approval', async () => {
    const txAHoldsBusinessLock = deferred();
    const releaseTxA = deferred();
    let txBLoaded = false;

    // Tx A: persist shape — review A lock, loader (takes the business lock),
    // then an auto-policy approval — held OPEN so the business lock stays held.
    const txAPromise = sqlA().begin(async (tx) => {
      await tx`SELECT id FROM reviews WHERE id = ${reviewAId}::uuid AND business_id = ${businessId}::uuid FOR UPDATE`;
      const state = await loadAutoApprovalRuntimeState(tx, {
        reviewId: reviewAId,
        businessId,
        accountId: accountId(),
      });
      expect(state.autoApprovedTodayCount).toBe(0);
      await insertAutoApprovedResponse(tx, reviewAId);
      txAHoldsBusinessLock.resolve();
      await releaseTxA.promise;
    });

    await txAHoldsBusinessLock.promise;

    // Tx B: same shape for a DIFFERENT review of the SAME business — must
    // block on the business FOR UPDATE until tx A commits.
    const txBPromise = sqlB().begin(async (tx) => {
      await tx`SELECT id FROM reviews WHERE id = ${reviewBId}::uuid AND business_id = ${businessId}::uuid FOR UPDATE`;
      const state = await loadAutoApprovalRuntimeState(tx, {
        reviewId: reviewBId,
        businessId,
        accountId: accountId(),
      });
      txBLoaded = true;
      return state;
    });

    // While tx A holds the business lock, tx B's loader must not complete.
    // (Timing-shaped in the safe direction: a slow scheduler can only make
    // this assertion trivially true, never flaky-false.)
    await sleep(250);
    expect(txBLoaded).toBe(false);

    releaseTxA.resolve();
    await txAPromise;
    const txBState = (await txBPromise) as Awaited<ReturnType<typeof loadAutoApprovalRuntimeState>>;

    expect(txBLoaded).toBe(true);
    // Tx B unblocked AFTER tx A committed, so it sees A's granted approval —
    // the strictness property: concurrent evaluations cannot both read the
    // pre-approval count.
    expect(txBState.autoApprovedTodayCount).toBe(1);
    expect(txBState.effectiveDailyCap).toBe(5);
  });
});
