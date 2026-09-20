// Live-Postgres suite for the ZernioRecentReviewPoller tombstone write (#1360).
//
// The unit suite pins the two UPDATEs against a mock `sql` whose `begin` just
// runs its callback — it can show the statements were issued, never that they
// commit or roll back TOGETHER. That is the whole defect: once a review is
// `deleted` the tombstone SELECT never returns it again, so a review tombstone
// that commits without its response sweep strands an `approved` response that
// can still reach the publisher. Only a real transaction can prove atomicity.
//
// Applies NO DDL (`ci:live-db-suites`): the abort comes from `abortingExecutor`
// with a poison that raises a REAL Postgres error, never a temporary constraint.
//
// `tombstoneMissingSourceReviews` takes its client as a parameter, but its
// module is a composition root that imports the `sql` singleton, which binds
// DATABASE_POOL_URL at import — so the poller is imported DYNAMICALLY, after
// beforeAll points that variable at the test DB (the ArchivalPoller pattern).
// `runOnce()` is deliberately NOT called: it sweeps every connected business
// on the shared container.

import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import postgres from 'postgres';
import type postgresType from 'postgres';
import { describeWithDb } from '@/__tests__/helpers/describe-with-db';
import { abortingExecutor } from '@/lib/shared/__tests__/helpers/abort-injection';
import {
  acquireLiveDbLock,
  assertLocalTestDatabaseUrl,
  LIVE_DB_LOCK_HOOK_TIMEOUT_MS,
  resolveTestDatabaseUrl,
  type LiveDbLock,
} from '@/lib/shared/__tests__/helpers/live-db-lock';
import {
  assertSchemaReady,
  type SchemaRequirement,
} from '@/lib/shared/__tests__/helpers/schema-ready';
import {
  cleanupTenantAccount,
  seedLocation,
  seedTenantAccount,
  type TenantSeed,
} from '@/lib/shared/__tests__/live-db-tenant';
import { REVIEW_STATUS } from '@/lib/reviews/status';
import { zernioProviderLocationName } from '@/lib/reviews/zernio-normalize';

type Tombstone = typeof import('../ZernioRecentReviewPoller').tombstoneMissingSourceReviews;

/** The `approved` fixture response is only insertable with this CHECK's column. */
const RESPONSES_APPROVAL_METHOD: SchemaRequirement = {
  migration: 'responses.approval_method',
  columns: ['responses.approval_method', 'responses.posting_error'],
  constraints: [{ table: 'responses', name: 'responses_approval_method_required' }],
};

const ZERNIO_ACCOUNT_ID = `tombstone-1360-account-${randomUUID()}`;
const ZERNIO_LOCATION_ID = 'tombstone-1360-location';

const testDatabaseUrl = resolveTestDatabaseUrl();

let db: postgresType.Sql | undefined;
let featureDatabaseLock: LiveDbLock | undefined;
let tenant: TenantSeed | undefined;
let businessId: string | undefined;
let tombstone: Tombstone | undefined;

function sql(): postgresType.Sql {
  if (!db) throw new Error('tombstone integration database was not initialized');
  return db;
}

function business(): string {
  if (!businessId) throw new Error('tombstone integration location was not seeded');
  return businessId;
}

function connection(): Parameters<Tombstone>[1] {
  return {
    business_id: business(),
    zernio_account_id: ZERNIO_ACCOUNT_ID,
    zernio_location_id: ZERNIO_LOCATION_ID,
    connected_at: new Date(Date.now() - 24 * 60 * 60_000),
  };
}

/** One live review that the feed no longer returns, with an `approved` reply. */
async function seedReviewWithApprovedResponse(): Promise<{ reviewId: string; responseId: string }> {
  const reviewId = randomUUID();
  const responseId = randomUUID();
  const marker = `tombstone-1360-${reviewId}`;
  await sql()`
    INSERT INTO reviews (
      id, business_id, provider, provider_review_id, provider_review_name,
      provider_location_name, reviewer_name, star_rating, review_text,
      review_date, detected_at, status
    ) VALUES (
      ${reviewId}::uuid, ${business()}::uuid, 'zernio', ${marker},
      ${`zernio://tombstone-1360/reviews/${marker}`},
      ${zernioProviderLocationName(ZERNIO_ACCOUNT_ID, ZERNIO_LOCATION_ID)},
      'Tombstone Reviewer', 5, 'Tombstone fixture review',
      NOW() - INTERVAL '1 hour', NOW() - INTERVAL '1 hour', ${REVIEW_STATUS.NEW}
    )
  `;
  await sql()`
    INSERT INTO responses (
      id, review_id, business_id, response_text, original_draft_text,
      status, approval_method
    ) VALUES (
      ${responseId}::uuid, ${reviewId}::uuid, ${business()}::uuid,
      'Tombstone fixture response', 'Tombstone fixture response',
      'approved', 'owner'
    )
  `;
  return { reviewId, responseId };
}

async function readState(ids: { reviewId: string; responseId: string }): Promise<{
  reviewStatus: string;
  responseStatus: string;
  postingError: string | null;
}> {
  const [row] = await sql()<
    { review_status: string; response_status: string; posting_error: string | null }[]
  >`
    SELECT rv.status AS review_status, rs.status AS response_status, rs.posting_error
      FROM reviews rv
      JOIN responses rs ON rs.review_id = rv.id
     WHERE rv.id = ${ids.reviewId}::uuid
       AND rs.id = ${ids.responseId}::uuid
       AND rv.business_id = ${business()}::uuid
  `;
  if (!row) throw new Error(`tombstone fixture ${ids.reviewId} vanished`);
  return {
    reviewStatus: row.review_status,
    responseStatus: row.response_status,
    postingError: row.posting_error,
  };
}

/**
 * A REAL Postgres error, so the transaction actually enters aborted state — a
 * JS throw would not, and a test built on one proves nothing about the hazard.
 */
const divisionByZero = (tx: postgresType.TransactionSql): Promise<unknown> =>
  tx`SELECT 1 / 0 AS poison`;

describeWithDb(
  'ZernioRecentReviewPoller tombstone write against live local Postgres',
  { enabled: Boolean(testDatabaseUrl), timeout: 90_000 },
  () => {
    beforeAll(async () => {
      const databaseUrl = assertLocalTestDatabaseUrl(testDatabaseUrl);
      featureDatabaseLock = await acquireLiveDbLock(databaseUrl);
      process.env.DATABASE_POOL_URL = databaseUrl;
      tombstone = (await import('../ZernioRecentReviewPoller')).tombstoneMissingSourceReviews;

      db = postgres(databaseUrl, {
        max: 4,
        prepare: false,
        connection: { statement_timeout: 30_000 },
      });
      await assertSchemaReady(db, [RESPONSES_APPROVAL_METHOD]);
      tenant = await seedTenantAccount(db, {
        userName: 'Tombstone Owner',
        accountDisplayName: 'Tombstone Account',
      });
      businessId = (await seedLocation(db, tenant.accountId, { name: 'Tombstone Location' }))
        .businessId;
    }, LIVE_DB_LOCK_HOOK_TIMEOUT_MS);

    afterEach(async () => {
      await sql()`DELETE FROM responses WHERE business_id = ${business()}::uuid`;
      await sql()`DELETE FROM reviews WHERE business_id = ${business()}::uuid`;
    }, 30_000);

    afterAll(async () => {
      try {
        if (db && businessId) {
          await sql()`DELETE FROM businesses WHERE id = ${businessId}::uuid`;
        }
        if (db && tenant) await cleanupTenantAccount(sql(), tenant);
      } finally {
        try {
          if (db) await db.end({ timeout: 5 });
        } finally {
          await featureDatabaseLock?.release();
          featureDatabaseLock = undefined;
        }
      }
    }, 120_000);

    it('tombstones the review and fails its non-terminal response together', async () => {
      if (!tombstone) throw new Error('poller was not imported');
      const ids = await seedReviewWithApprovedResponse();

      // An EMPTY complete feed — also the real-driver proof that an empty
      // `::text[]` bind still matches every row.
      const deleted = await tombstone(sql(), connection(), new Set(), true);

      expect(deleted).toBe(1);
      expect(await readState(ids)).toEqual({
        reviewStatus: REVIEW_STATUS.DELETED,
        responseStatus: 'failed',
        postingError: 'review_deleted_at_source',
      });
    });

    it('rolls the review tombstone back when the transaction aborts, and the next cycle recovers', async () => {
      if (!tombstone) throw new Error('poller was not imported');
      const ids = await seedReviewWithApprovedResponse();
      const feed = new Set(['some-other-review-still-at-source']);

      await expect(
        tombstone(abortingExecutor(sql(), divisionByZero), connection(), feed, true),
      ).rejects.toThrow(/division by zero/);

      // Mutation-checked 2026-09-20: with the two UPDATEs issued on `db`
      // instead of `tx` (autocommit, the pre-#1360 shape) this reads `deleted`.
      expect(await readState(ids)).toEqual({
        reviewStatus: REVIEW_STATUS.NEW,
        responseStatus: 'approved',
        postingError: null,
      });

      // The recovery half: the review is still selectable, so the next cycle
      // finishes the job instead of orphaning the `approved` response forever.
      expect(await tombstone(sql(), connection(), feed, true)).toBe(1);
      expect(await readState(ids)).toEqual({
        reviewStatus: REVIEW_STATUS.DELETED,
        responseStatus: 'failed',
        postingError: 'review_deleted_at_source',
      });
    });
  },
);
