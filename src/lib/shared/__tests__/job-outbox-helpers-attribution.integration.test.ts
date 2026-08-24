// Live-DB behaviour of `enqueueSolicitationAttribution` (#632 Task 4).
//
// The guard is a deliberately COARSER superset of the candidate predicate —
// `delivery_status = 'sent' AND attributed_at IS NULL`, and nothing else. It
// carries no time bound and must never grow one (plan deviation D3): the
// candidate window is anchor-relative, so a `NOW()`-relative guard would drop
// legitimate matches silently. These cases exist because the mocked unit suite
// `job-outbox-helpers.test.ts` cannot prove a live `INSERT … SELECT … WHERE NOT
// EXISTS` guard at all (round-1 finding A8).
//
// Shape follows `attribution.integration.test.ts`: `resolveTestDatabaseUrl` +
// `describeWithDb`, the cross-process live-DB lock, and `assertSchemaReady`
// from `@/lib/shared/__tests__/helpers/schema-ready` — migration 114 is
// ASSERTED, never applied (`ci:live-db-suites` forbids run-time DDL).

import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import type postgresType from 'postgres';
import { describeWithDb } from '@/__tests__/helpers/describe-with-db';
import {
  acquireLiveDbLock,
  assertLocalTestDatabaseUrl,
  LIVE_DB_LOCK_HOOK_TIMEOUT_MS,
  resolveTestDatabaseUrl,
  type LiveDbLock,
} from '@/lib/shared/__tests__/helpers/live-db-lock';
import {
  assertSchemaReady,
  MIGRATION_091_SEND_MODE_SPINE_LIFECYCLE,
  type SchemaRequirement,
} from '@/lib/shared/__tests__/helpers/schema-ready';
import {
  insertOutreach,
  seedContactCsvUpload,
  type OutreachStamp,
} from '@/lib/shared/__tests__/helpers/outreach-fixture';
import {
  cleanupTenantAccount,
  seedLocation,
  seedTenantAccount,
  type TenantSeed,
} from '@/lib/shared/__tests__/live-db-tenant';
import { REVIEW_STATUS } from '@/lib/reviews/status';
import { attributeReview } from '@/lib/solicitation/attribution';
import { QUEUE_NAMES } from '../queue-names';
import { enqueueSolicitationAttribution } from '../job-outbox-helpers';

/**
 * The MINIMAL requirement this suite depends on, and deliberately not a third
 * copy of the four-column one (deviation D18): what the helper's `ON CONFLICT`
 * needs is the partial unique index, and migration 114 runs inside one
 * `BEGIN … COMMIT`, so the index — its last created object — cannot exist
 * without the columns. `schema-ready.ts` is outside this task's edit surface;
 * D18's follow-up PR owns moving these constants there.
 */
const MIGRATION_114_ATTRIBUTION_OUTBOX_INFLIGHT: SchemaRequirement = {
  migration: '114_solicitation_attribution',
  indexes: ['job_outbox_solicitation_attribution_inflight'],
};

const CONTACT_NAME = 'Dana Rodriguez';
const REVIEWER_NAME = 'Dana Rodriguez';

const testDatabaseUrl = resolveTestDatabaseUrl();

let db: postgresType.Sql | undefined;
let featureDatabaseLock: LiveDbLock | undefined;

function sql(): postgresType.Sql {
  if (!db) throw new Error('attribution enqueue integration database was not initialized');
  return db;
}

interface Fixture {
  tenant: TenantSeed;
  accountId: string;
  businessId: string;
  uploadId: string;
  batchId: string;
}

let fixture: Fixture | undefined;

function fx(): Fixture {
  if (!fixture) throw new Error('attribution enqueue fixture was not seeded');
  return fixture;
}

// ── fixtures ────────────────────────────────────────────────────────────────

async function seedFixture(): Promise<Fixture> {
  const tenant = await seedTenantAccount(sql(), {
    userName: 'Attribution Enqueue Owner',
    accountDisplayName: 'Attribution Enqueue Account',
  });
  const businessId = randomUUID();
  await seedLocation(sql(), tenant.accountId, {
    businessId,
    name: 'Attribution Enqueue Location',
    isPrimary: true,
  });

  const uploadId = await seedContactCsvUpload(sql(), {
    accountId: tenant.accountId,
    businessId,
    attestedByUserId: tenant.userId,
    filenamePrefix: 'attribution-632-enqueue',
    attestationVersion: 'attribution-632-test',
  });

  const batchId = randomUUID();
  await sql()`
    INSERT INTO solicitation_batches (
      id, account_id, business_id, source_upload_id, created_at, built_at
    ) VALUES (
      ${batchId}::uuid, ${tenant.accountId}::uuid, ${businessId}::uuid,
      ${uploadId}::uuid, NOW() - INTERVAL '60 days', NOW() - INTERVAL '60 days'
    )
  `;

  return { tenant, accountId: tenant.accountId, businessId, uploadId, batchId };
}

interface OutreachInput {
  contactName: string;
  /** SQL fragment; `null` for a status 091 forbids a `sent_at`. */
  sentAt: OutreachStamp;
  queuedAt: OutreachStamp;
  deliveryStatus?: string;
}

/** A fresh contact → ask → outreach chain, one row per call. */
async function seedOutreach(input: OutreachInput): Promise<string> {
  const f = fx();
  const contactId = randomUUID();
  await sql()`
    INSERT INTO solicitation_contacts (id, business_id, name, email, created_by_upload_id)
    VALUES (${contactId}::uuid, ${f.businessId}::uuid, ${input.contactName},
            ${`${contactId}@example.test`}, ${f.uploadId}::uuid)
  `;

  const askId = randomUUID();
  await sql()`
    INSERT INTO solicitation_asks (
      id, account_id, business_id, batch_id, contact_id, status,
      withheld_reason, evidence, decided_at
    ) VALUES (
      ${askId}::uuid, ${f.accountId}::uuid, ${f.businessId}::uuid,
      ${f.batchId}::uuid, ${contactId}::uuid, 'send', NULL,
      ${sql().json({
        contact_id: contactId,
        policy_version: 'attribution-632-fixture',
        decision: 'send',
      })},
      NOW() - INTERVAL '60 days'
    )
  `;

  return insertOutreach(sql(), {
    accountId: f.accountId,
    businessId: f.businessId,
    batchId: f.batchId,
    askId,
    contactId,
    deliveryStatus: input.deliveryStatus ?? 'sent',
    queuedAt: input.queuedAt,
    sentAt: input.sentAt,
  });
}

async function seedReview(reviewerName: string): Promise<string> {
  const reviewId = randomUUID();
  const marker = `attribution-632-enqueue-${reviewId}`;
  await sql()`
    INSERT INTO reviews (
      id, business_id, provider, provider_review_id, provider_review_name,
      provider_location_name, reviewer_name, star_rating, review_text,
      review_date, detected_at, status
    ) VALUES (
      ${reviewId}::uuid, ${fx().businessId}::uuid, 'zernio',
      ${marker}, ${`zernio://attribution-632-enqueue/reviews/${marker}`},
      'zernio://attribution-632-enqueue/locations/1', ${reviewerName},
      5, 'Attribution enqueue fixture review',
      NOW(), NOW(), ${REVIEW_STATUS.NEW}
    )
  `;
  return reviewId;
}

// ── the call under test ─────────────────────────────────────────────────────

/**
 * The helper takes a TransactionSql — invariant #2's whole point. Each call
 * gets its OWN transaction here so the in-flight `ON CONFLICT` is exercised
 * across committed rows rather than within one statement's snapshot.
 */
async function enqueue(reviewId: string, correlationId?: string): Promise<string | null> {
  return sql().begin(async (tx) =>
    enqueueSolicitationAttribution(tx, {
      reviewId,
      businessId: fx().businessId,
      ...(correlationId === undefined ? {} : { correlationId }),
    }),
  ) as Promise<string | null>;
}

// ── readers ─────────────────────────────────────────────────────────────────

interface OutboxRow {
  id: string;
  topic: string;
  aggregate_type: string;
  aggregate_id: string | null;
  status: string;
  payload: unknown;
}

async function readAttributionJobs(reviewId?: string): Promise<OutboxRow[]> {
  const f = fx();
  return sql()<OutboxRow[]>`
    SELECT jo.id::text AS id, jo.topic, jo.aggregate_type,
           jo.aggregate_id::text AS aggregate_id, jo.status, jo.payload
      FROM job_outbox jo
     WHERE jo.topic = ${QUEUE_NAMES.SOLICITATION_ATTRIBUTION}
       AND jo.aggregate_id IN (
         SELECT r.id FROM reviews r WHERE r.business_id = ${f.businessId}::uuid
       )
       ${reviewId === undefined ? sql()`` : sql()`AND jo.aggregate_id = ${reviewId}::uuid`}
     ORDER BY jo.created_at
  `;
}

/** Postgres.js behind PgBouncer can hand JSONB back as a string. */
function jsonObject(value: unknown): Record<string, unknown> {
  const parsed: unknown = typeof value === 'string' ? JSON.parse(value) : value;
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('expected a JSONB object');
  }
  return parsed as Record<string, unknown>;
}

// ── cleanup ─────────────────────────────────────────────────────────────────

async function resetFixtureRows(): Promise<void> {
  const f = fx();
  await sql()`
    DELETE FROM job_outbox
     WHERE aggregate_id IN (SELECT id FROM reviews WHERE business_id = ${f.businessId}::uuid)
  `;
  await sql()`DELETE FROM solicitation_outreach WHERE business_id = ${f.businessId}::uuid`;
  await sql()`DELETE FROM solicitation_asks WHERE business_id = ${f.businessId}::uuid`;
  await sql()`DELETE FROM solicitation_contacts WHERE business_id = ${f.businessId}::uuid`;
  await sql()`DELETE FROM reviews WHERE business_id = ${f.businessId}::uuid`;
}

describeWithDb(
  'solicitation_attribution enqueue against live local Postgres',
  { enabled: Boolean(testDatabaseUrl), timeout: 180_000 },
  () => {
    beforeAll(async () => {
      const databaseUrl = assertLocalTestDatabaseUrl(testDatabaseUrl);
      featureDatabaseLock = await acquireLiveDbLock(databaseUrl);
      db = postgres(databaseUrl, {
        max: 4,
        prepare: false,
        connection: { statement_timeout: 30_000 },
      });
      await assertSchemaReady(db, [
        MIGRATION_091_SEND_MODE_SPINE_LIFECYCLE,
        MIGRATION_114_ATTRIBUTION_OUTBOX_INFLIGHT,
      ]);
      fixture = await seedFixture();
    }, LIVE_DB_LOCK_HOOK_TIMEOUT_MS);

    afterEach(async () => {
      await resetFixtureRows();
    }, 60_000);

    afterAll(async () => {
      try {
        if (db && fixture) {
          await resetFixtureRows();
          await sql()`DELETE FROM solicitation_batches WHERE business_id = ${fixture.businessId}::uuid`;
          await sql()`DELETE FROM contact_csv_uploads WHERE business_id = ${fixture.businessId}::uuid`;
          await sql()`DELETE FROM businesses WHERE id = ${fixture.businessId}::uuid`;
          await cleanupTenantAccount(sql(), fixture.tenant);
          fixture = undefined;
        }
      } finally {
        try {
          if (db) await db.end({ timeout: 5 });
        } finally {
          await featureDatabaseLock?.release();
          featureDatabaseLock = undefined;
        }
      }
    }, LIVE_DB_LOCK_HOOK_TIMEOUT_MS);

    describe('enqueueSolicitationAttribution', () => {
      it('enqueueSolicitationAttribution: enqueues nothing when the business has never sent an ask', async () => {
        // The positive control is the RENDERED row: it carries the matching
        // contact name and differs from an eligible one only in
        // `delivery_status`, so the empty outbox can only be the guard's
        // `= 'sent'` arm. That is every business while SOLICITATION_SEND_ENABLED
        // is off — the whole reason the guard exists.
        await seedOutreach({
          contactName: CONTACT_NAME,
          deliveryStatus: 'rendered',
          queuedAt: null,
          sentAt: null,
        });
        const reviewId = await seedReview(REVIEWER_NAME);

        expect(await enqueue(reviewId, 'corr-never-sent')).toBeNull();
        expect(await readAttributionJobs()).toEqual([]);
      });

      it('enqueueSolicitationAttribution: enqueues exactly one row per new review with an eligible candidate', async () => {
        await seedOutreach({
          contactName: CONTACT_NAME,
          queuedAt: sql()`NOW() - INTERVAL '2 days'`,
          sentAt: sql()`NOW() - INTERVAL '2 days'`,
        });

        const first = await seedReview(REVIEWER_NAME);
        const second = await seedReview(REVIEWER_NAME);

        const firstOutboxId = await enqueue(first, 'corr-first');
        const secondOutboxId = await enqueue(second, 'corr-second');
        expect(firstOutboxId).not.toBeNull();
        expect(secondOutboxId).not.toBeNull();
        expect(firstOutboxId).not.toBe(secondOutboxId);

        const rows = await readAttributionJobs();
        expect(rows).toHaveLength(2);
        expect(rows.map((row) => row.aggregate_id).sort()).toEqual([first, second].sort());

        const firstRow = rows.find((row) => row.aggregate_id === first);
        expect(firstRow).toBeDefined();
        expect(firstRow).toMatchObject({
          topic: 'solicitation_attribution',
          aggregate_type: 'review',
          status: 'pending',
        });
        // ids only, and NO account_id (deviation D3) — the account is resolved
        // from the business FK inside attributeReview, so no wrong account id
        // can ride a job.
        expect(jsonObject(firstRow!.payload)).toEqual({
          review_id: first,
          business_id: fx().businessId,
          correlation_id: 'corr-first',
        });
      });

      it('enqueueSolicitationAttribution: a business whose only sent outreach is out of window still enqueues and resolves no_candidates', async () => {
        // Deviation D3, proved end to end. The ask is 40 days old — far outside
        // the 14-day Attribution window — and the contact name matches the
        // reviewer exactly, so nothing but the window can decide the outcome.
        // The row IS written: the guard is a LOSSLESS superset, and the window
        // is the matcher's job. A `sent_at > NOW() - 14 days` guard would write
        // nothing here and silently lose every anchor-relative match.
        await seedOutreach({
          contactName: CONTACT_NAME,
          queuedAt: sql()`NOW() - INTERVAL '40 days'`,
          sentAt: sql()`NOW() - INTERVAL '40 days'`,
        });
        const reviewId = await seedReview(REVIEWER_NAME);

        expect(await enqueue(reviewId, 'corr-out-of-window')).not.toBeNull();
        const rows = await readAttributionJobs(reviewId);
        expect(rows).toHaveLength(1);

        const match = await sql().begin(async (tx) =>
          attributeReview(tx, { reviewId, businessId: fx().businessId }),
        );
        expect(match).toEqual({ resolution: 'no_candidates' });
      });

      it('enqueueSolicitationAttribution: a duplicate enqueue leaves one in-flight row for the review', async () => {
        await seedOutreach({
          contactName: CONTACT_NAME,
          queuedAt: sql()`NOW() - INTERVAL '2 days'`,
          sentAt: sql()`NOW() - INTERVAL '2 days'`,
        });
        const reviewId = await seedReview(REVIEWER_NAME);

        const firstOutboxId = await enqueue(reviewId, 'corr-dupe');
        expect(firstOutboxId).not.toBeNull();

        // Migration 114's partial unique index suppressed the second insert, so
        // there is no RETURNING row — the atomic, exception-free "a lookback for
        // this review is already in flight" signal. Without the index this
        // statement would THROW, inside the review-ingest transaction (D5).
        expect(await enqueue(reviewId, 'corr-dupe')).toBeNull();

        const rows = await readAttributionJobs(reviewId);
        expect(rows).toHaveLength(1);
        expect(rows[0]!.id).toBe(firstOutboxId);

        // The guard is IN-FLIGHT, not permanent: once the worker completes the
        // row, a later review-driven lookback for the same aggregate is free to
        // enqueue again. The index predicate is what encodes that, byte for
        // byte, and this is the half that proves it is not a blanket unique.
        await sql()`
          UPDATE job_outbox SET status = 'completed', completed_at = NOW()
           WHERE id = ${firstOutboxId}::uuid
        `;
        const thirdOutboxId = await enqueue(reviewId, 'corr-dupe');
        expect(thirdOutboxId).not.toBeNull();
        expect(thirdOutboxId).not.toBe(firstOutboxId);
        expect(await readAttributionJobs(reviewId)).toHaveLength(2);
      });
    });
  },
);
