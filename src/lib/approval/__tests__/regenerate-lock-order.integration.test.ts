// #1444: lock-order.md listed the regenerate lanes (session/token/callback)
// as "not proved" against the auto-policy downgrade lane
// (worker/jobs/publisher/auto-policy-downgrade.ts) and the publisher
// failed-hook (worker/jobs/publisher/failed-hook.ts) on responses <->
// businesses. Both of those lanes lock businesses FOR UPDATE before
// responses FOR UPDATE (the downgrade ladder; failed-hook's
// lockPublisherFailureLane shares it), and NEITHER filters that lock by
// response status — only the eventual WRITE is status-guarded. That is the
// opposite order from lockPendingResponse's responses-then-businesses
// (locks.ts), which every approval-lane claim (approve/edit/regenerate)
// uses. Before #1444, only approve/edit took the reviews-row anchor
// (anchorReviewLockOrder) first; regenerate did not, so an unanchored
// regenerate racing either lane on the SAME response closed a real AB-BA
// cycle.
//
// Suite 1 proves that cycle was REAL, not hypothetical: it reproduces the
// OLD (pre-#1444) regenerate order with raw SQL and races it against the
// downgrade/failed-hook order, and a genuine Postgres deadlock (40P01)
// results.
//
// Suite 2 proves the fix (session-mode.ts/token-mode.ts/callback-mode.ts
// now call anchorReviewLockOrder before lockPendingResponse, exactly like
// approve/edit): the FIXED regenerateBySession, raced the same way against
// the same downgrade-shaped transaction, blocks on the shared reviews lock
// instead of racing ahead to a response/business lock — so the AB-BA cycle
// is no longer reachable, and both transactions complete.
//
// Gated on TEST_DATABASE_POOL_URL (skips cleanly without one). No migration
// SQL runs here (#573): schema is asserted, not applied.

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
import { assertSchemaReady } from '@/lib/shared/__tests__/helpers/schema-ready';
import { regenerateBySession } from '../session-mode';
import type { SessionAuditContext } from '../audit';

const testDatabaseUrl = process.env.TEST_DATABASE_POOL_URL;

// Two connections, one each: both suites below need GENUINELY concurrent
// transactions, which a single max-1 pool cannot give
// (auto-approval-daily-cap.integration.test.ts precedent).
let dbA: postgresType.Sql | undefined;
let dbB: postgresType.Sql | undefined;
let tenant: TenantSeed | undefined;

const businessId = randomUUID();

// actor_user_id is a real FK column — built from the seeded tenant once it
// exists, not a placeholder string.
function sessionAudit(): SessionAuditContext {
  if (!tenant) throw new Error('regenerate lock-order tenant was not seeded');
  return { actorUserId: tenant.userId, ipAddress: null };
}

function sqlA(): postgresType.Sql {
  if (!dbA) throw new Error('regenerate lock-order database A was not initialized');
  return dbA;
}

function sqlB(): postgresType.Sql {
  if (!dbB) throw new Error('regenerate lock-order database B was not initialized');
  return dbB;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolveFn!: () => void;
  const promise = new Promise<void>((res) => {
    resolveFn = res;
  });
  return { promise, resolve: resolveFn };
}

const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

function isDeadlock(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && (error as { code?: unknown }).code === '40P01';
}

interface SeededPending {
  reviewId: string;
  responseId: string;
}

async function seedPendingResponse(): Promise<SeededPending> {
  const reviewId = randomUUID();
  const responseId = randomUUID();
  await sqlA()`
    INSERT INTO reviews (
      id, business_id, provider, provider_review_id, provider_review_name,
      provider_location_name, reviewer_name, star_rating, review_text, status
    ) VALUES (
      ${reviewId}::uuid, ${businessId}::uuid, 'zernio', ${`lock-order-1444-${reviewId}`},
      ${`zernio://lock-order-1444/reviews/${reviewId}`}, 'zernio://lock-order-1444/locations/1',
      'Reviewer', 5, 'Great service, thank you.', 'responded'
    )
  `;
  await sqlA()`
    INSERT INTO responses (
      id, review_id, business_id, response_text, original_draft_text,
      response_language, status, version
    ) VALUES (
      ${responseId}::uuid, ${reviewId}::uuid, ${businessId}::uuid, 'Thanks!', 'Thanks!',
      'en', 'pending_approval', 1
    )
  `;
  return { reviewId, responseId };
}

async function readResponseStatus(responseId: string): Promise<string> {
  const [row] = await sqlA()<{ status: string }[]>`
    SELECT status FROM responses WHERE id = ${responseId}::uuid
  `;
  if (!row) throw new Error(`expected response ${responseId}`);
  return row.status;
}

/**
 * Mirrors the FULL statement ladder of
 * downgradeAutoApprovedResponseForManualReviewInTx AND
 * lockPublisherFailureLane (worker/jobs/publisher/auto-policy-downgrade.ts,
 * worker/jobs/publisher/failed-hook.ts): reviews FOR UPDATE, then businesses
 * FOR UPDATE, then responses FOR UPDATE. Neither production lane filters the
 * businesses/responses locks by status — only the eventual write is status
 * guarded — so this is an honest reproduction of what those lanes lock, not
 * a simplification of it.
 */
async function downgradeShapedLocks(
  tx: postgresType.TransactionSql,
  ids: { reviewId: string; responseId: string },
): Promise<void> {
  await tx`SELECT id FROM reviews WHERE id = ${ids.reviewId}::uuid FOR UPDATE`;
  await tx`SELECT id, account_id FROM businesses WHERE id = ${businessId}::uuid FOR UPDATE`;
  await tx`
    SELECT status, approval_method FROM responses
    WHERE id = ${ids.responseId}::uuid AND business_id = ${businessId}::uuid
    FOR UPDATE
  `;
}

describeWithDb('regenerate lock order against live Postgres (#1444)', { timeout: 30_000 }, () => {
  beforeAll(async () => {
    dbA = postgres(testDatabaseUrl!, { max: 1, prepare: false });
    dbB = postgres(testDatabaseUrl!, { max: 1, prepare: false });
    await assertSchemaReady(dbA, []);
    tenant = await seedTenantAccount(dbA, {
      userName: 'Regenerate Lock Order Owner',
      accountDisplayName: 'Regenerate Lock Order Account',
    });
    await dbA`
      INSERT INTO businesses (id, name, owner_name, owner_email, account_id, subscription_status)
      VALUES (
        ${businessId}::uuid, 'Regenerate Lock Order Biz', 'Owner', ${tenant.ownerEmail},
        ${tenant.accountId}::uuid, 'active'
      )
    `;
  });

  afterAll(async () => {
    if (dbB) await dbB.end({ timeout: 5 });
    if (dbA && tenant) {
      await sqlA()`DELETE FROM approval_audit_log WHERE business_id = ${businessId}::uuid`;
      await sqlA()`
        DELETE FROM job_outbox
        WHERE aggregate_id IN (SELECT id FROM responses WHERE business_id = ${businessId}::uuid)
      `;
      await sqlA()`DELETE FROM responses WHERE business_id = ${businessId}::uuid`;
      await sqlA()`DELETE FROM reviews WHERE business_id = ${businessId}::uuid`;
      await sqlA()`DELETE FROM businesses WHERE id = ${businessId}::uuid`;
      await cleanupTenantAccount(sqlA(), tenant);
    }
    if (dbA) await dbA.end({ timeout: 5 });
  });

  it(
    'the pre-#1444 regenerate order (responses -> businesses, no reviews anchor) '
      + 'deadlocks against the downgrade/failed-hook order (reviews -> businesses -> responses)',
    async () => {
      const { reviewId, responseId } = await seedPendingResponse();

      const regenHasResponseLock = deferred();
      const downgradeHasBusinessLock = deferred();
      const bothHoldFirstLocks = Promise.all([
        regenHasResponseLock.promise,
        downgradeHasBusinessLock.promise,
      ]);

      // The UNANCHORED shape lockPendingResponse had before #1444: responses
      // FOR UPDATE, then businesses FOR SHARE (assertLocationNotArchived) —
      // no reviews lock at all.
      const oldRegen = sqlA().begin(async (tx) => {
        await tx`SELECT status FROM responses WHERE id = ${responseId}::uuid FOR UPDATE`;
        regenHasResponseLock.resolve();
        await bothHoldFirstLocks;
        await tx`SELECT archived_at FROM businesses WHERE id = ${businessId}::uuid FOR SHARE`;
      });

      // The downgrade/failed-hook shape: reviews FOR UPDATE (no conflict —
      // regenerate never touches reviews), then businesses FOR UPDATE
      // (uncontested here too, since regenerate hasn't reached businesses
      // yet), THEN responses FOR UPDATE — which is where it collides with
      // the response lock oldRegen already holds.
      const downgrade = sqlB().begin(async (tx) => {
        await tx`SELECT id FROM reviews WHERE id = ${reviewId}::uuid FOR UPDATE`;
        await tx`SELECT id, account_id FROM businesses WHERE id = ${businessId}::uuid FOR UPDATE`;
        downgradeHasBusinessLock.resolve();
        await bothHoldFirstLocks;
        await tx`
          SELECT status, approval_method FROM responses
          WHERE id = ${responseId}::uuid AND business_id = ${businessId}::uuid
          FOR UPDATE
        `;
      });

      const settled = await Promise.allSettled([oldRegen, downgrade]);
      const rejected = settled.filter(
        (s): s is PromiseRejectedResult => s.status === 'rejected',
      );
      const fulfilled = settled.filter((s) => s.status === 'fulfilled');

      // Real Postgres deadlock detection (40P01): exactly one side is
      // killed, the other completes. Neither transaction issued a WRITE, so
      // this is purely a lock-acquisition proof — the response row itself
      // is untouched either way.
      expect(rejected).toHaveLength(1);
      expect(fulfilled).toHaveLength(1);
      expect(isDeadlock(rejected[0]!.reason)).toBe(true);
      expect(await readResponseStatus(responseId)).toBe('pending_approval');
    },
  );

  it(
    'the fixed regenerateBySession (reviews-row anchor first, #1444) blocks behind — '
      + 'and never deadlocks against — the downgrade/failed-hook order',
    async () => {
      const { reviewId, responseId } = await seedPendingResponse();

      const downgradeHoldsAllLocks = deferred();
      const releaseDowngrade = deferred();
      let regenerateResolved = false;

      const downgrade = sqlA().begin(async (tx) => {
        await downgradeShapedLocks(tx, { reviewId, responseId });
        downgradeHoldsAllLocks.resolve();
        await releaseDowngrade.promise;
        // No write: regenerate's eventual success below reads a row this
        // transaction left untouched, not one it happened to mutate.
      });

      await downgradeHoldsAllLocks.promise;

      const regenerate = sqlB()
        .begin((tx) =>
          regenerateBySession(tx, responseId, businessId, sessionAudit(), 'lock-order-1444'),
        )
        .then(() => {
          regenerateResolved = true;
        });

      // The fixed lane's FIRST real lock is anchorReviewLockOrder's reviews
      // FOR UPDATE — the SAME row the downgrade-shaped tx holds — so it must
      // still be blocked here, never having raced ahead to a response or
      // business lock out of order.
      await sleep(300);
      expect(regenerateResolved).toBe(false);

      releaseDowngrade.resolve();
      await downgrade;
      await regenerate;

      expect(regenerateResolved).toBe(true);
      expect(await readResponseStatus(responseId)).toBe('superseded');
    },
  );
});
