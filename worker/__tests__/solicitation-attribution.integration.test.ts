// Live-DB handler behaviour for `SolicitationAttributionWorker` (#632 Task 5):
// idempotence under concurrent replay, and the attempt-guarded outbox
// completion the worker owes its row on every resolution — not just the
// attributed one — so the watchdog never redispatches settled work.
//
// Task 0 authors both promised titles parked; Task 5 lands the bodies. The
// runnable form follows `attribution.integration.test.ts` for suite shape and
// the cross-process live-DB lock, and asserts the schema with
// `assertSchemaReady` from `@/lib/shared/__tests__/helpers/schema-ready`
// instead of applying DDL at run time.
//
// The outbox rows are written by the REAL producer,
// `enqueueSolicitationAttribution`, and then advanced to `dispatched` by hand —
// the state OutboxPoller leaves behind. Nothing here fabricates a `job_outbox`
// row, so the enqueue guard, the payload shape and the handler's completion CAS
// are exercised as one chain rather than three assumptions.

import { randomUUID } from 'node:crypto';
import type { Job } from 'bullmq';
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
import { enqueueSolicitationAttribution } from '@/lib/shared/job-outbox-helpers';
import type { SolicitationAttributionPayload } from '@/lib/shared/worker-types';
import { handleSolicitationAttribution } from '../jobs/solicitation-attribution/SolicitationAttributionWorker';

/**
 * Only what THIS suite depends on, and deliberately not a third copy of the
 * four-column requirement (deviation D18). Migration 114 runs inside one
 * `BEGIN … COMMIT`, and both indexes named here are built ON the objects that
 * migration adds — the in-flight one on `job_outbox` for the enqueue's
 * `ON CONFLICT`, the unique one on the attribution columns this handler writes.
 * Neither can exist without them. `schema-ready.ts` is outside this task's edit
 * surface; D18's follow-up PR owns moving these constants there.
 */
const MIGRATION_114_ATTRIBUTION_WORKER_PATH: SchemaRequirement = {
  migration: '114_solicitation_attribution',
  indexes: [
    'job_outbox_solicitation_attribution_inflight',
    'solicitation_outreach_attributed_review_uniq',
  ],
};

const CONTACT_NAME = 'Dana Rodriguez';
const REVIEWER_NAME = 'Dana Rodriguez';
const OTHER_CONTACT_NAME = 'Priya Sharma';
/** Same first name, different surname — a SECOND match, not a near-miss. */
const AMBIGUOUS_CONTACT_NAME = 'Dana Rodrigues';

const testDatabaseUrl = resolveTestDatabaseUrl();

let db: postgresType.Sql | undefined;
let featureDatabaseLock: LiveDbLock | undefined;

function sql(): postgresType.Sql {
  if (!db) throw new Error('attribution worker integration database was not initialized');
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
  if (!fixture) throw new Error('attribution worker fixture was not seeded');
  return fixture;
}

// ── fixtures ────────────────────────────────────────────────────────────────

async function seedFixture(): Promise<Fixture> {
  const tenant = await seedTenantAccount(sql(), {
    userName: 'Attribution Worker Owner',
    accountDisplayName: 'Attribution Worker Account',
  });
  const businessId = randomUUID();
  await seedLocation(sql(), tenant.accountId, {
    businessId,
    name: 'Attribution Worker Location',
    isPrimary: true,
  });

  const uploadId = await seedContactCsvUpload(sql(), {
    accountId: tenant.accountId,
    businessId,
    attestedByUserId: tenant.userId,
    filenamePrefix: 'attribution-632-worker',
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

/** A TERMINAL Lazy child — the run `review_attributed` must attach to. */
async function seedLazyChild(): Promise<string> {
  const f = fx();
  const runId = randomUUID();
  await sql()`
    INSERT INTO agent_runs (
      id, account_id, business_id, kind, subject_type, subject_id,
      status, started_at, ended_at, correlation_id
    ) VALUES (
      ${runId}::uuid, ${f.accountId}::uuid, ${f.businessId}::uuid,
      'solicitation_ask', 'solicitation_ask', ${randomUUID()},
      'completed', NOW() - INTERVAL '20 days', NOW() - INTERVAL '20 days',
      'attribution-632-worker'
    )
  `;
  return runId;
}

interface OutreachInput {
  contactName: string;
  /** SQL fragment. */
  sentAt: OutreachStamp;
  queuedAt: OutreachStamp;
  agentRunId?: string | null;
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

  const outreachId = await insertOutreach(sql(), {
    accountId: f.accountId,
    businessId: f.businessId,
    batchId: f.batchId,
    askId,
    contactId,
    deliveryStatus: 'sent',
    queuedAt: input.queuedAt,
    sentAt: input.sentAt,
  });

  await sql()`
    UPDATE solicitation_outreach
       SET agent_run_id = ${input.agentRunId ?? null}
     WHERE id = ${outreachId}::uuid
       AND account_id = ${f.accountId}::uuid
       AND business_id = ${f.businessId}::uuid
  `;

  return outreachId;
}

async function seedReview(reviewerName: string): Promise<string> {
  const reviewId = randomUUID();
  const marker = `attribution-632-worker-${reviewId}`;
  await sql()`
    INSERT INTO reviews (
      id, business_id, provider, provider_review_id, provider_review_name,
      provider_location_name, reviewer_name, star_rating, review_text,
      review_date, detected_at, status
    ) VALUES (
      ${reviewId}::uuid, ${fx().businessId}::uuid, 'zernio',
      ${marker}, ${`zernio://attribution-632-worker/reviews/${marker}`},
      'zernio://attribution-632-worker/locations/1', ${reviewerName},
      5, 'Attribution worker fixture review',
      NOW(), NOW(), ${REVIEW_STATUS.NEW}
    )
  `;
  return reviewId;
}

// ── the dispatch chain ──────────────────────────────────────────────────────

/**
 * The real producer, then the state OutboxPoller leaves behind. Returns the
 * outbox id the worker owes a completion to.
 */
async function enqueueAndDispatch(reviewId: string, attempt = 1): Promise<string> {
  const outboxId = (await sql().begin(async (tx) =>
    enqueueSolicitationAttribution(tx, {
      reviewId,
      businessId: fx().businessId,
      correlationId: 'attribution-632-worker',
    }),
  )) as string | null;
  if (outboxId === null) {
    throw new Error(`enqueueSolicitationAttribution suppressed the row for review ${reviewId}`);
  }
  await sql()`
    UPDATE job_outbox
       SET status = 'dispatched', attempts = ${attempt}, dispatched_at = NOW()
     WHERE id = ${outboxId}::uuid
  `;
  return outboxId;
}

/**
 * A BullMQ job carrying the outbox handle. The `id` is DELIBERATELY random per
 * call: idempotence is keyed on the deterministic outbox id in the payload,
 * never on the BullMQ job id, and two calls sharing one outbox id with two
 * different job ids is the only shape that can prove it.
 */
function job(
  reviewId: string,
  outboxId: string,
  outboxAttempt = 1,
): Job<SolicitationAttributionPayload> {
  return {
    id: `bull-${randomUUID()}`,
    data: {
      review_id: reviewId,
      business_id: fx().businessId,
      outbox_id: outboxId,
      outbox_attempt: outboxAttempt,
      correlation_id: 'attribution-632-worker',
    },
  } as Job<SolicitationAttributionPayload>;
}

// ── readers ─────────────────────────────────────────────────────────────────

interface AttributedRow {
  id: string;
  attributed_review_id: string | null;
  attribution_rule: string | null;
}

async function readAttributed(): Promise<AttributedRow[]> {
  const f = fx();
  return sql()<AttributedRow[]>`
    SELECT id::text AS id, attributed_review_id::text AS attributed_review_id, attribution_rule
      FROM solicitation_outreach
     WHERE account_id = ${f.accountId}::uuid
       AND business_id = ${f.businessId}::uuid
       AND attributed_at IS NOT NULL
     ORDER BY id
  `;
}

interface OutcomeRow {
  agent_run_id: string | null;
  outcome_kind: string;
  unit_count: number;
}

async function readOutcomes(): Promise<OutcomeRow[]> {
  const f = fx();
  return sql()<OutcomeRow[]>`
    SELECT agent_run_id::text AS agent_run_id, outcome_kind, unit_count
      FROM agent_outcomes
     WHERE account_id = ${f.accountId}::uuid
       AND business_id = ${f.businessId}::uuid
     ORDER BY occurred_at
  `;
}

interface OutboxStateRow {
  status: string;
  attempts: number;
  completed_at: Date | null;
}

async function readOutbox(outboxId: string): Promise<OutboxStateRow> {
  const [row] = await sql()<OutboxStateRow[]>`
    SELECT status, attempts, completed_at FROM job_outbox WHERE id = ${outboxId}::uuid
  `;
  if (!row) throw new Error(`outbox row ${outboxId} vanished`);
  return row;
}

// ── cleanup ─────────────────────────────────────────────────────────────────

async function resetFixtureRows(): Promise<void> {
  const f = fx();
  await sql()`
    DELETE FROM job_outbox
     WHERE aggregate_id IN (SELECT id FROM reviews WHERE business_id = ${f.businessId}::uuid)
  `;
  await sql()`DELETE FROM agent_outcomes WHERE account_id = ${f.accountId}::uuid`;
  await sql()`DELETE FROM solicitation_outreach WHERE business_id = ${f.businessId}::uuid`;
  await sql()`DELETE FROM solicitation_asks WHERE business_id = ${f.businessId}::uuid`;
  await sql()`DELETE FROM solicitation_contacts WHERE business_id = ${f.businessId}::uuid`;
  await sql()`DELETE FROM agent_runs WHERE account_id = ${f.accountId}::uuid`;
  await sql()`DELETE FROM reviews WHERE business_id = ${f.businessId}::uuid`;
}

describeWithDb(
  'SolicitationAttributionWorker against live local Postgres',
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
        MIGRATION_114_ATTRIBUTION_WORKER_PATH,
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

    describe('handleSolicitationAttribution', () => {
      it('handleSolicitationAttribution: concurrent replay produces one attribution and one review_attributed outcome', async () => {
        const runId = await seedLazyChild();
        const outreachId = await seedOutreach({
          contactName: CONTACT_NAME,
          queuedAt: sql()`NOW() - INTERVAL '2 days'`,
          sentAt: sql()`NOW() - INTERVAL '2 days'`,
          agentRunId: runId,
        });
        const reviewId = await seedReview(REVIEWER_NAME);
        const outboxId = await enqueueAndDispatch(reviewId);

        // TWO handler invocations, SAME outbox attempt, DIFFERENT BullMQ job
        // ids, genuinely in flight at once. The completion CAS is the first
        // statement inside the transaction, so the loser blocks on that row
        // lock, re-reads `status = 'dispatched'` after the winner commits, sees
        // zero rows and performs no mutation at all.
        await Promise.all([
          handleSolicitationAttribution(sql(), job(reviewId, outboxId)),
          handleSolicitationAttribution(sql(), job(reviewId, outboxId)),
        ]);

        const attributed = await readAttributed();
        expect(attributed).toHaveLength(1);
        expect(attributed[0]?.id).toBe(outreachId);
        expect(attributed[0]?.attributed_review_id).toBe(reviewId);
        expect(attributed[0]?.attribution_rule).toBe('full_name');

        const outcomes = await readOutcomes();
        expect(outcomes).toEqual([
          { agent_run_id: runId, outcome_kind: 'review_attributed', unit_count: 1 },
        ]);

        const outbox = await readOutbox(outboxId);
        expect(outbox.status).toBe('completed');
        expect(outbox.completed_at).not.toBeNull();

        // A THIRD run after both settled is the sequential replay of the same
        // deterministic key: still one attribution, still one outcome.
        await handleSolicitationAttribution(sql(), job(reviewId, outboxId));
        expect(await readAttributed()).toHaveLength(1);
        expect(await readOutcomes()).toHaveLength(1);
      });
    });

    describe('SolicitationAttributionWorker', () => {
      it('SolicitationAttributionWorker: completes the owned outbox attempt on every successful resolution', async () => {
        // EVERY resolution, not just the attributed one: a row left
        // `dispatched` is redispatched by the watchdog until it exhausts, and
        // three of these four arms write nothing that would ever be noticed.
        //
        // Each arm keeps at least one `sent`, unattributed outreach row so the
        // enqueue guard fires — the coarse guard is deliberately a superset of
        // the candidate window (deviation D3).
        const arms: { name: string; setup: () => Promise<string> }[] = [
          {
            name: 'attributed',
            setup: async () => {
              await seedOutreach({
                contactName: CONTACT_NAME,
                queuedAt: sql()`NOW() - INTERVAL '3 days'`,
                sentAt: sql()`NOW() - INTERVAL '3 days'`,
                agentRunId: await seedLazyChild(),
              });
              return seedReview(REVIEWER_NAME);
            },
          },
          {
            name: 'no_candidates',
            setup: async () => {
              // Sent, unattributed — so the enqueue fires — but 20 days back,
              // outside the 14-day Attribution window.
              await seedOutreach({
                contactName: CONTACT_NAME,
                queuedAt: sql()`NOW() - INTERVAL '20 days'`,
                sentAt: sql()`NOW() - INTERVAL '20 days'`,
              });
              return seedReview(REVIEWER_NAME);
            },
          },
          {
            name: 'no_match',
            setup: async () => {
              await seedOutreach({
                contactName: OTHER_CONTACT_NAME,
                queuedAt: sql()`NOW() - INTERVAL '4 days'`,
                sentAt: sql()`NOW() - INTERVAL '4 days'`,
              });
              return seedReview(REVIEWER_NAME);
            },
          },
          {
            name: 'ambiguous',
            setup: async () => {
              for (const contactName of [CONTACT_NAME, AMBIGUOUS_CONTACT_NAME]) {
                await seedOutreach({
                  contactName,
                  queuedAt: sql()`NOW() - INTERVAL '5 days'`,
                  sentAt: sql()`NOW() - INTERVAL '5 days'`,
                });
              }
              // "Dana R." matches BOTH surnames on the initial rule, so the
              // matcher abstains rather than picking one.
              return seedReview('Dana R.');
            },
          },
        ];

        for (const arm of arms) {
          const reviewId = await arm.setup();
          const outboxId = await enqueueAndDispatch(reviewId);

          await handleSolicitationAttribution(sql(), job(reviewId, outboxId));

          const outbox = await readOutbox(outboxId);
          expect(outbox.status, `${arm.name} left its outbox row ${outbox.status}`)
            .toBe('completed');
          expect(outbox.completed_at, `${arm.name} completed without a timestamp`)
            .not.toBeNull();

          const attributed = await readAttributed();
          expect(attributed, `${arm.name} wrote the wrong number of attributions`)
            .toHaveLength(arm.name === 'attributed' ? 1 : 0);

          await resetFixtureRows();
        }

        // …and the completion is OWNED, not unconditional. Dispatch attempt 1,
        // then let the watchdog redispatch as attempt 2 while the stale worker
        // is still running: the stale attempt must complete nothing and mutate
        // nothing, or it stamps `completed` onto a live newer attempt.
        await seedOutreach({
          contactName: CONTACT_NAME,
          queuedAt: sql()`NOW() - INTERVAL '2 days'`,
          sentAt: sql()`NOW() - INTERVAL '2 days'`,
          agentRunId: await seedLazyChild(),
        });
        const staleReviewId = await seedReview(REVIEWER_NAME);
        const staleOutboxId = await enqueueAndDispatch(staleReviewId, 2);

        await handleSolicitationAttribution(sql(), job(staleReviewId, staleOutboxId, 1));

        const staleOutbox = await readOutbox(staleOutboxId);
        expect(staleOutbox.status).toBe('dispatched');
        expect(staleOutbox.attempts).toBe(2);
        expect(staleOutbox.completed_at).toBeNull();
        expect(await readAttributed()).toEqual([]);
        expect(await readOutcomes()).toEqual([]);
      });
    });
  },
);
