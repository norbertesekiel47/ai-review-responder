// The ingest call site (#632 Task 4): the `solicitation_attribution` outbox row
// is written inside `processReview`'s existing `sql.begin`, so the review INSERT
// and the enqueue share one transaction (invariant #2) — and the Zernio backfill
// lane (`importReview`) is deliberately excluded.
//
// A matcher failure must never fail review ingest: the match runs in its own
// worker, never inside the ingest transaction.
//
// Shape follows `src/lib/solicitation/__tests__/attribution.integration.test.ts`:
// `resolveTestDatabaseUrl` + `describeWithDb`, the cross-process live-DB lock,
// and `assertSchemaReady` from `@/lib/shared/__tests__/helpers/schema-ready` —
// migration 114 is ASSERTED, never applied (`ci:live-db-suites` forbids
// run-time DDL). Transaction aborts come from `abortingExecutor`, never a
// temporary constraint.

import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
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
import { QUEUE_NAMES } from '@/lib/shared/queue-names';
import { attributeReview } from '@/lib/solicitation/attribution';
import type { MonitoredReview } from '../types';
import { importReview, processReview } from '../process-review';

/**
 * The MINIMAL requirement this suite depends on, and deliberately not a third
 * copy of the four-column one (deviation D18): what the ingest enqueue needs is
 * the partial unique index its `ON CONFLICT` infers, and migration 114 runs
 * inside one `BEGIN … COMMIT`, so the index — its last created object — cannot
 * exist without the columns. `schema-ready.ts` is outside this task's edit
 * surface; D18's follow-up PR owns moving these constants there.
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
  if (!db) throw new Error('process-review attribution database was not initialized');
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
  if (!fixture) throw new Error('process-review attribution fixture was not seeded');
  return fixture;
}

// ── fixtures ────────────────────────────────────────────────────────────────

async function seedFixture(): Promise<Fixture> {
  const tenant = await seedTenantAccount(sql(), {
    userName: 'Ingest Attribution Owner',
    accountDisplayName: 'Ingest Attribution Account',
  });
  const businessId = randomUUID();
  await seedLocation(sql(), tenant.accountId, {
    businessId,
    name: 'Ingest Attribution Location',
    isPrimary: true,
  });

  const uploadId = await seedContactCsvUpload(sql(), {
    accountId: tenant.accountId,
    businessId,
    attestedByUserId: tenant.userId,
    filenamePrefix: 'attribution-632-ingest',
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

/** A fresh contact → ask → outreach chain — an eligible, in-window sent ask. */
async function seedSentOutreach(sentAt: OutreachStamp): Promise<string> {
  const f = fx();
  const contactId = randomUUID();
  await sql()`
    INSERT INTO solicitation_contacts (id, business_id, name, email, created_by_upload_id)
    VALUES (${contactId}::uuid, ${f.businessId}::uuid, ${CONTACT_NAME},
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
    deliveryStatus: 'sent',
    queuedAt: sentAt,
    sentAt,
  });
}

/** One provider-shaped review payload, unique per call. */
function monitoredReview(label: string): MonitoredReview {
  const marker = `attribution-632-ingest-${label}-${randomUUID()}`;
  return {
    review: {
      reviewerName: REVIEWER_NAME,
      starRating: 5,
      reviewText: 'Attribution ingest fixture review',
      reviewDate: new Date().toISOString(),
      detectedLanguage: 'en',
    },
    identity: {
      provider: 'zernio',
      providerReviewId: marker,
      providerReviewName: `zernio://attribution-632-ingest/reviews/${marker}`,
      providerLocationName: 'zernio://attribution-632-ingest/locations/1',
      googleReviewName: null,
      identityStrategy: 'zernio_id',
    },
    contentHash: `hash-${marker}`,
  };
}

// ── readers ─────────────────────────────────────────────────────────────────

async function reviewIdFor(monitored: MonitoredReview): Promise<string | null> {
  const [row] = await sql()<{ id: string }[]>`
    SELECT id::text AS id FROM reviews
     WHERE business_id = ${fx().businessId}::uuid
       AND provider = ${monitored.identity.provider}
       AND provider_review_name = ${monitored.identity.providerReviewName}
  `;
  return row?.id ?? null;
}

interface OutboxRow {
  id: string;
  topic: string;
  aggregate_type: string;
  aggregate_id: string | null;
  status: string;
  payload: unknown;
}

async function readAttributionJobs(): Promise<OutboxRow[]> {
  return sql()<OutboxRow[]>`
    SELECT jo.id::text AS id, jo.topic, jo.aggregate_type,
           jo.aggregate_id::text AS aggregate_id, jo.status, jo.payload
      FROM job_outbox jo
     WHERE jo.topic = ${QUEUE_NAMES.SOLICITATION_ATTRIBUTION}
       AND jo.aggregate_id IN (
         SELECT r.id FROM reviews r WHERE r.business_id = ${fx().businessId}::uuid
       )
     ORDER BY jo.created_at
  `;
}

async function countReviews(): Promise<number> {
  const [row] = await sql()<{ count: number }[]>`
    SELECT COUNT(*)::int AS count FROM reviews WHERE business_id = ${fx().businessId}::uuid
  `;
  return row?.count ?? 0;
}

async function readOutreachAttribution(outreachId: string): Promise<{
  attributed_review_id: string | null;
  attributed_at: Date | null;
}> {
  const [row] = await sql()<{ attributed_review_id: string | null; attributed_at: Date | null }[]>`
    SELECT attributed_review_id::text AS attributed_review_id, attributed_at
      FROM solicitation_outreach
     WHERE id = ${outreachId}::uuid
       AND account_id = ${fx().accountId}::uuid
       AND business_id = ${fx().businessId}::uuid
  `;
  if (!row) throw new Error(`outreach ${outreachId} vanished`);
  return row;
}

/** Postgres.js behind PgBouncer can hand JSONB back as a string. */
function jsonObject(value: unknown): Record<string, unknown> {
  const parsed: unknown = typeof value === 'string' ? JSON.parse(value) : value;
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('expected a JSONB object');
  }
  return parsed as Record<string, unknown>;
}

/**
 * A REAL Postgres error, so the transaction actually enters aborted state — a
 * JS throw would not, and a test built on one proves nothing about the hazard.
 */
const divisionByZero = (tx: postgresType.TransactionSql): Promise<unknown> =>
  tx`SELECT 1 / 0 AS poison`;

// ── cleanup ─────────────────────────────────────────────────────────────────

async function resetFixtureRows(): Promise<void> {
  const f = fx();
  await sql()`
    DELETE FROM job_outbox
     WHERE aggregate_id IN (SELECT id FROM reviews WHERE business_id = ${f.businessId}::uuid)
  `;
  await sql()`DELETE FROM analytics_events WHERE account_id = ${f.accountId}::uuid`;
  await sql()`DELETE FROM agent_outcomes WHERE account_id = ${f.accountId}::uuid`;
  await sql()`DELETE FROM agent_runs WHERE account_id = ${f.accountId}::uuid`;
  await sql()`DELETE FROM solicitation_outreach WHERE business_id = ${f.businessId}::uuid`;
  await sql()`DELETE FROM solicitation_asks WHERE business_id = ${f.businessId}::uuid`;
  await sql()`DELETE FROM solicitation_contacts WHERE business_id = ${f.businessId}::uuid`;
  await sql()`DELETE FROM reviews WHERE business_id = ${f.businessId}::uuid`;
}

describeWithDb(
  'live review ingest attribution enqueue against live local Postgres',
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

    describe('processReview', () => {
      it('processReview: the review INSERT and solicitation_attribution outbox row commit or roll back together', async () => {
        // Invariant #2 in both directions. A Postgres-then-enqueue
        // implementation would pass the commit half and fail the abort half —
        // which is the half that matters, because that is the shape that loses
        // work silently.
        await seedSentOutreach(sql()`NOW() - INTERVAL '2 days'`);

        // ── commit together ──
        const committed = monitoredReview('committed');
        expect(await processReview(sql(), committed, fx().businessId, 'corr-commit')).toBe('new');

        const committedId = await reviewIdFor(committed);
        expect(committedId).not.toBeNull();

        const afterCommit = await readAttributionJobs();
        expect(afterCommit).toHaveLength(1);
        expect(afterCommit[0]).toMatchObject({
          topic: 'solicitation_attribution',
          aggregate_type: 'review',
          aggregate_id: committedId,
          status: 'pending',
        });
        expect(jsonObject(afterCommit[0]!.payload)).toEqual({
          review_id: committedId,
          business_id: fx().businessId,
          correlation_id: 'corr-commit',
        });

        // ── roll back together ──
        // The poison runs AFTER processReview's callback resolves, so the
        // review INSERT and the enqueue have both already happened inside the
        // transaction that is about to abort.
        const rolledBack = monitoredReview('rolled-back');
        await expect(
          processReview(
            abortingExecutor(sql(), divisionByZero),
            rolledBack,
            fx().businessId,
            'corr-rollback',
          ),
        ).rejects.toThrow();

        expect(await reviewIdFor(rolledBack)).toBeNull();
        expect(await countReviews()).toBe(1);
        // Still exactly the committed review's row — the aborted ingest left no
        // orphan job behind, and took none of the committed one with it.
        const afterRollback = await readAttributionJobs();
        expect(afterRollback).toHaveLength(1);
        expect(afterRollback[0]!.aggregate_id).toBe(committedId);
      });

      it('processReview: a later attribution matcher failure cannot roll back a committed live-ingest review', async () => {
        // Why #632 ships an outbox topic instead of an inline call: the match
        // runs in the WORKER's transaction, so a matcher fault rolls back its
        // own writes and nothing else. Ingest has already committed.
        const outreachId = await seedSentOutreach(sql()`NOW() - INTERVAL '2 days'`);

        const monitored = monitoredReview('matcher-failure');
        expect(await processReview(sql(), monitored, fx().businessId, 'corr-matcher')).toBe('new');
        const reviewId = await reviewIdFor(monitored);
        expect(reviewId).not.toBeNull();

        // The matcher WOULD have attributed this row — the contact name matches
        // the reviewer exactly — so there is a real write for the abort to undo.
        await expect(
          abortingExecutor(sql(), divisionByZero).begin(async (tx) =>
            attributeReview(tx, { reviewId: reviewId!, businessId: fx().businessId }),
          ),
        ).rejects.toThrow();

        // Ingest survived, untouched.
        expect(await reviewIdFor(monitored)).toBe(reviewId);
        expect(await countReviews()).toBe(1);
        const jobs = await readAttributionJobs();
        expect(jobs).toHaveLength(1);
        expect(jobs[0]).toMatchObject({ aggregate_id: reviewId, status: 'pending' });

        // The matcher's own writes did not: its transaction rolled back whole,
        // so the row stays a candidate for the retry the outbox will drive.
        const outreach = await readOutreachAttribution(outreachId);
        expect(outreach.attributed_review_id).toBeNull();
        expect(outreach.attributed_at).toBeNull();
      });
    });

    describe('importReview', () => {
      it('importReview: never enqueues solicitation_attribution on the Zernio backfill lane', async () => {
        // The intake's non-goals exclude the backfill lane: an imported
        // historical review was never caused by an ask sent after it. The LIVE
        // review in the same fixture is the positive control — without it, a
        // guard that simply never fires would pass this test.
        await seedSentOutreach(sql()`NOW() - INTERVAL '2 days'`);

        const live = monitoredReview('live-control');
        expect(await processReview(sql(), live, fx().businessId, 'corr-live')).toBe('new');
        const liveId = await reviewIdFor(live);

        const imported = monitoredReview('imported');
        expect(await importReview(sql(), imported, fx().businessId, 'corr-import')).toBe('new');
        const importedId = await reviewIdFor(imported);
        expect(importedId).not.toBeNull();

        const jobs = await readAttributionJobs();
        expect(jobs).toHaveLength(1);
        expect(jobs[0]!.aggregate_id).toBe(liveId);
        expect(jobs.some((job) => job.aggregate_id === importedId)).toBe(false);

        // The import lane writes NO job_outbox row at all (invariants #2/#3) —
        // not merely no attribution one.
        const [row] = await sql()<{ count: number }[]>`
          SELECT COUNT(*)::int AS count FROM job_outbox
           WHERE aggregate_id = ${importedId}::uuid
        `;
        expect(row?.count).toBe(0);
      });
    });
  },
);
