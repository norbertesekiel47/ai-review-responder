// Real-Postgres behavioral suite for the WS4 daily-cap accounting in
// loadAutoApprovalRuntimeState (spec §2.3): the unit suite only asserts SQL
// *text*; this drives the loader against live Postgres so the migration-074
// dial columns, the `businesses` FOR UPDATE serialization, and the UTC-day
// count execute for real. The serialization test is the strictness guarantee:
// two concurrent persist-shaped txs on ONE business must not both read a
// below-cap count (which would overshoot the cap).
//
// Every tx here mirrors persistResponseAndNotify's PRODUCTION statement order:
// reviews FOR UPDATE → businesses FOR UPDATE (tx statement #2) → responses
// INSERT (whose business_id FK takes an implicit FOR KEY SHARE on the
// businesses row) → loadAutoApprovalRuntimeState → approve UPDATE (the full
// approveAutoPolicyAndSchedule statement, incl. the make_interval named-
// notation veto-window stamp + RETURNING — this suite is its only live
// executor) → commit. That ordering doubles as the DEADLOCK regression test:
// with the pre-fix
// order (responses INSERT before any businesses FOR UPDATE), two of these txs
// for different reviews of the same business each hold a KEY SHARE and each
// wait to upgrade to FOR UPDATE — a share-then-upgrade cycle Postgres aborts
// with 40P01 (reproduced in review of commit 258d0664).
//
// Gated on TEST_DATABASE_POOL_URL (skips cleanly without one). Migration 074
// is applied in beforeAll via the shared guarded helper (probe-then-apply, so
// it stays cheap and lock-free once 074 is on the shared test DB).

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
import { applyMigration074IfMissing } from '@/lib/shared/__tests__/helpers/apply-migration-074';
import { APPROVAL_METHOD } from '@/lib/auto-approval/types';
import { loadAutoApprovalRuntimeState, type AutoApprovalRuntimeState } from '../auto-approval';

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

/**
 * Production statement order for the head of the persist tx (persist.ts):
 * reviews FOR UPDATE first, businesses FOR UPDATE second (BEFORE the responses
 * INSERT, so the FK's implicit KEY SHARE is subsumed rather than upgraded),
 * then the INSERT of a pending row exactly as persist.ts writes it
 * (status pending_approval, approval_method NULL).
 */
async function persistShapedHead(
  tx: postgresType.TransactionSql,
  reviewId: string,
): Promise<string> {
  await tx`SELECT id FROM reviews WHERE id = ${reviewId}::uuid AND business_id = ${businessId}::uuid FOR UPDATE`;
  await tx`SELECT id FROM businesses WHERE id = ${businessId}::uuid FOR UPDATE`;
  const responseId = randomUUID();
  await tx`
    INSERT INTO responses (id, review_id, business_id, response_text, original_draft_text, version, status, approval_method)
    VALUES (${responseId}::uuid, ${reviewId}::uuid, ${businessId}::uuid, 'Thanks!', 'Thanks!', 1, 'pending_approval', NULL)
  `;
  return responseId;
}

/**
 * The persist tx's auto-policy approve UPDATE, byte-shaped after production
 * (persist.ts approveAutoPolicyAndSchedule): full SET list including the
 * `make_interval(mins => $n)` named-notation veto-window stamp, the
 * pending_approval status guard, and `RETURNING auto_post_scheduled_at`.
 * Running it here live-proves the named-notation bind against real Postgres —
 * no other automated test executes it.
 */
async function approveAutoPolicy(
  tx: postgresType.TransactionSql,
  responseId: string,
  vetoWindowMinutes: number,
): Promise<Date> {
  const [scheduled] = await tx<{ auto_post_scheduled_at: Date }[]>`
    UPDATE responses
    SET status = 'approved',
        approval_method = ${APPROVAL_METHOD.AUTO_POLICY},
        approved_text = 'Thanks!',
        approved_at = NOW(),
        auto_post_scheduled_at = NOW() + make_interval(mins => ${vetoWindowMinutes}),
        posting_error = NULL,
        updated_at = NOW()
    WHERE id = ${responseId}::uuid
      AND business_id = ${businessId}::uuid
      AND status = 'pending_approval'
    RETURNING auto_post_scheduled_at
  `;
  if (!scheduled) throw new Error('auto_approve_transition_lost');
  return scheduled.auto_post_scheduled_at;
}

describeWithDb('WS4 daily-cap accounting in loadAutoApprovalRuntimeState against live Postgres', { timeout: 30_000 }, () => {
  beforeAll(async () => {
    dbA = postgres(testDatabaseUrl!, { max: 1, prepare: false });
    dbB = postgres(testDatabaseUrl!, { max: 1, prepare: false });
    await applyMigration074IfMissing(dbA);
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
      // Full persist-shaped head (locks + pending INSERT); the pending row is
      // approval_method NULL, so it must NOT count against the cap.
      const responseId = await persistShapedHead(tx, reviewAId);
      const loaded = await loadAutoApprovalRuntimeState(tx, {
        reviewId: reviewAId,
        businessId,
        accountId: accountId(),
      });
      // Same-tx cleanup: the serialization test below re-inserts a version-1
      // row for review A, which unique_review_version and the one-non-terminal
      // -per-review index would otherwise reject.
      await tx`DELETE FROM responses WHERE id = ${responseId}::uuid AND business_id = ${businessId}::uuid`;
      return loaded;
    });

    expect(state.effectivePolicy.source).toBe('account_default');
    expect(state.effectivePolicy.threshold).toBe(4);
    expect(state.effectivePolicy.vetoWindowMinutes).toBe(30);
    expect(state.effectivePolicy.dailyAutoPostCap).toBe(5);
    expect(state.effectivePolicy.suspended).toBe(false);
    expect(state.autoApprovedTodayCount).toBe(0);
  });

  it('serializes two concurrent persist-shaped txs on the business lock; the second counts the first approval', async () => {
    const txAHoldsBusinessLock = deferred();
    const releaseTxA = deferred();
    let txBLoaded = false;

    // Tx A: full production persist shape — review A lock, business lock,
    // pending INSERT, loader, auto-policy approve UPDATE — held OPEN so the
    // business lock stays held.
    const txAPromise = sqlA().begin(async (tx) => {
      const responseId = await persistShapedHead(tx, reviewAId);
      const state = await loadAutoApprovalRuntimeState(tx, {
        reviewId: reviewAId,
        businessId,
        accountId: accountId(),
      });
      expect(state.autoApprovedTodayCount).toBe(0);
      const scheduledAt = await approveAutoPolicy(
        tx,
        responseId,
        state.effectivePolicy.vetoWindowMinutes,
      );
      // Live proof of the make_interval named-notation bind: the stamped
      // deadline is the policy's 30-minute veto window from DB NOW() (wide
      // tolerance absorbs client/DB clock skew without flake risk).
      const minutesOut = (scheduledAt.getTime() - Date.now()) / 60_000;
      expect(minutesOut).toBeGreaterThan(25);
      expect(minutesOut).toBeLessThan(35);
      txAHoldsBusinessLock.resolve();
      await releaseTxA.promise;
    });

    await txAHoldsBusinessLock.promise;

    // Tx B: same shape for a DIFFERENT review of the SAME business — must
    // block on the business FOR UPDATE (tx statement #2) until tx A commits.
    // Against the pre-fix statement order this pair would instead 40P01
    // (see the header comment), so completing at all IS the regression check.
    const txBPromise = sqlB().begin(async (tx) => {
      const responseId = await persistShapedHead(tx, reviewBId);
      const state = await loadAutoApprovalRuntimeState(tx, {
        reviewId: reviewBId,
        businessId,
        accountId: accountId(),
      });
      txBLoaded = true;
      await approveAutoPolicy(tx, responseId, state.effectivePolicy.vetoWindowMinutes);
      return state;
    });

    // While tx A holds the business lock, tx B's loader must not complete.
    // (Timing-shaped in the safe direction: a slow scheduler can only make
    // this assertion trivially true, never flaky-false.)
    await sleep(250);
    expect(txBLoaded).toBe(false);

    releaseTxA.resolve();
    await txAPromise;
    const txBState = (await txBPromise) as AutoApprovalRuntimeState;

    expect(txBLoaded).toBe(true);
    // Tx B unblocked AFTER tx A committed, so it sees A's granted approval —
    // the strictness property: concurrent evaluations cannot both read the
    // pre-approval count.
    expect(txBState.autoApprovedTodayCount).toBe(1);
    expect(txBState.effectivePolicy.dailyAutoPostCap).toBe(5);
  });
});
