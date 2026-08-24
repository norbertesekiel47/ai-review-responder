// Live-DB half of #632's `review_attributed` shadow attribution: the candidate
// query's eight predicates, the write transaction, the spine outcome, the
// no-billing claim, crossed-tenant isolation, and the owner read model.
//
// Shape follows `approval-system-halt.integration.test.ts`: `resolveTestDatabaseUrl`
// + `describeWithDb`, the cross-process live-DB lock, `assertSchemaReady` from
// `@/lib/shared/__tests__/helpers/schema-ready` (migration 114 ASSERTED, never
// applied — `ci:live-db-suites` forbids run-time DDL), and the shared outreach
// fixtures from `@/lib/shared/__tests__/helpers/outreach-fixture`.
//
// TIMESTAMPS ARE TEXT, END TO END. Every anchor-relative case compares a
// `solicitation_outreach.sent_at` against a window derived from a `reviews` row,
// and postgres.js TRUNCATES microseconds decoding timestamptz into a JS `Date`
// (#520) — a JS round-trip would mis-order the two sides by under a millisecond
// on the exactly-14-days case. `dbStamp` resolves one instant on the database
// and carries it as `::text`; `stampPlus` shifts it in SQL.
//
// The four `listAttributedReviews:` titles stay parked until Task 6.

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
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
import { REVIEW_STATUS } from '@/lib/reviews/status';
import { attributeReview, type AttributionMatch } from '../attribution';

/**
 * Declared here rather than imported: the canonical constant is still local to
 * `src/lib/shared/__tests__/migration-114-solicitation-attribution.integration.test.ts`
 * (deviation D11), and `schema-ready.ts` is outside this task's two-file surface.
 * Whichever task can reach `schema-ready.ts` owes the move — this is the SECOND
 * copy D11 predicted, and it must not become a third.
 */
const MIGRATION_114_SOLICITATION_ATTRIBUTION: SchemaRequirement = {
  migration: '114_solicitation_attribution',
  columns: [
    'solicitation_outreach.attributed_review_id',
    'solicitation_outreach.attributed_at',
    'solicitation_outreach.attribution_rule',
    'solicitation_outreach.attribution_detail',
  ],
  indexes: [
    'solicitation_outreach_attributed_review_uniq',
    'solicitation_outreach_attribution_candidates',
    'job_outbox_solicitation_attribution_inflight',
  ],
  constraints: [
    { table: 'solicitation_outreach', name: 'solicitation_outreach_attribution_consistency' },
  ],
};

const MODULE_PATH = 'src/lib/solicitation/attribution.ts';
const CONTACT_NAME = 'Dana Rodriguez';
const REVIEWER_NAME = 'Dana Rodriguez';
const OTHER_CONTACT_NAME = 'Priya Sharma';

const testDatabaseUrl = resolveTestDatabaseUrl();

let db: postgresType.Sql | undefined;
let featureDatabaseLock: LiveDbLock | undefined;

function sql(): postgresType.Sql {
  if (!db) throw new Error('attribution integration database was not initialized');
  return db;
}

/** One account + one location + the upload and batch every ask hangs off. */
interface Fixture {
  tenant: TenantSeed;
  accountId: string;
  businessId: string;
  uploadId: string;
  batchId: string;
}

type FixtureName = 'primary' | 'sibling' | 'crossed';

const fixtures = new Map<FixtureName, Fixture>();

function fixture(which: FixtureName): Fixture {
  const value = fixtures.get(which);
  if (!value) throw new Error(`attribution fixture ${which} was not seeded`);
  return value;
}

// ── fixtures ────────────────────────────────────────────────────────────────

/**
 * A location under an ALREADY-seeded account. `sibling` uses this: invariant #8
 * demands BOTH `account_id` and `business_id`, and only a second location under
 * the SAME account can tell an account-only scope apart from a correct one.
 * `businesses_account_primary_uniq` allows one primary per account, so it is a
 * secondary.
 */
async function seedFixtureUnder(
  tenant: TenantSeed,
  label: string,
  isPrimary: boolean,
): Promise<Fixture> {
  const businessId = randomUUID();
  await seedLocation(sql(), tenant.accountId, {
    businessId,
    name: `Attribution ${label} Location`,
    isPrimary,
  });

  const uploadId = await seedContactCsvUpload(sql(), {
    accountId: tenant.accountId,
    businessId,
    attestedByUserId: tenant.userId,
    filenamePrefix: `attribution-632-${label}`,
    attestationVersion: 'attribution-632-test',
  });

  const batchId = randomUUID();
  await sql()`
    INSERT INTO solicitation_batches (
      id, account_id, business_id, source_upload_id, created_at, built_at
    ) VALUES (
      ${batchId}::uuid, ${tenant.accountId}::uuid, ${businessId}::uuid,
      ${uploadId}::uuid, NOW() - INTERVAL '30 days', NOW() - INTERVAL '30 days'
    )
  `;

  return { tenant, accountId: tenant.accountId, businessId, uploadId, batchId };
}

/** A fresh account plus its primary location. */
async function seedFixture(label: string): Promise<Fixture> {
  const tenant = await seedTenantAccount(sql(), {
    userName: `Attribution ${label} Owner`,
    accountDisplayName: `Attribution ${label} Account`,
  });
  return seedFixtureUnder(tenant, label, true);
}

/**
 * One instant resolved ONCE on the database and carried as text. `::text`
 * preserves microseconds; a JS `Date` would not (#520), and this value anchors
 * both sides of the candidate window.
 */
async function dbStamp(offset: string): Promise<string> {
  const [row] = await sql()<{ at: string }[]>`SELECT (NOW() - ${offset}::interval)::text AS at`;
  if (!row) throw new Error('dbStamp returned no row');
  return row.at;
}

/** `base + interval`, evaluated in SQL. Pass a negative interval to go back. */
function stampPlus(base: string, interval: string): OutreachStamp {
  return sql()`${base}::timestamptz + ${interval}::interval`;
}

interface OutreachInput {
  fixture: Fixture;
  contactName: string;
  /** SQL fragment; `null` only for a status 091 forbids a `sent_at`. */
  sentAt: OutreachStamp;
  queuedAt: OutreachStamp;
  deliveryStatus?: string;
  dispositionReason?: string | null;
  bouncedAt?: OutreachStamp;
  complainedAt?: OutreachStamp;
  unsubscribedAt?: OutreachStamp;
  /** The Lazy child the outcome must attach to. */
  agentRunId?: string | null;
}

/**
 * A fresh contact → ask → outreach chain, one row per call. Each outreach gets
 * its OWN contact and ask so `solicitation_asks_batch_contact_uniq` and 091's
 * per-ask attempt uniqueness can never reject a fixture for a reason no case is
 * about.
 *
 * The async-signal columns and `agent_run_id` are stamped by a follow-up UPDATE:
 * `insertOutreach` deliberately owns only 091's fifteen NOT NULL columns.
 */
async function seedOutreach(input: OutreachInput): Promise<string> {
  const fx = input.fixture;
  const contactId = randomUUID();
  await sql()`
    INSERT INTO solicitation_contacts (id, business_id, name, email, created_by_upload_id)
    VALUES (${contactId}::uuid, ${fx.businessId}::uuid, ${input.contactName},
            ${`${contactId}@example.test`}, ${fx.uploadId}::uuid)
  `;

  const askId = randomUUID();
  await sql()`
    INSERT INTO solicitation_asks (
      id, account_id, business_id, batch_id, contact_id, status,
      withheld_reason, evidence, decided_at
    ) VALUES (
      ${askId}::uuid, ${fx.accountId}::uuid, ${fx.businessId}::uuid,
      ${fx.batchId}::uuid, ${contactId}::uuid, 'send', NULL,
      ${sql().json({
        contact_id: contactId,
        policy_version: 'attribution-632-fixture',
        decision: 'send',
      })},
      NOW() - INTERVAL '30 days'
    )
  `;

  const outreachId = await insertOutreach(sql(), {
    accountId: fx.accountId,
    businessId: fx.businessId,
    batchId: fx.batchId,
    askId,
    contactId,
    deliveryStatus: input.deliveryStatus ?? 'sent',
    dispositionReason: input.dispositionReason ?? null,
    queuedAt: input.queuedAt,
    sentAt: input.sentAt,
  });

  await sql()`
    UPDATE solicitation_outreach
       SET bounced_at      = ${input.bouncedAt ?? null},
           complained_at   = ${input.complainedAt ?? null},
           unsubscribed_at = ${input.unsubscribedAt ?? null},
           agent_run_id    = ${input.agentRunId ?? null}
     WHERE id = ${outreachId}::uuid
       AND account_id = ${fx.accountId}::uuid
       AND business_id = ${fx.businessId}::uuid
  `;

  return outreachId;
}

/** The Send batch parent — the run the outcome must NEVER attach to. */
async function seedSendParent(fx: Fixture): Promise<string> {
  const runId = randomUUID();
  await sql()`
    INSERT INTO agent_runs (
      id, account_id, business_id, kind, subject_type, subject_id,
      status, started_at, ended_at, correlation_id
    ) VALUES (
      ${runId}::uuid, ${fx.accountId}::uuid, ${fx.businessId}::uuid,
      'solicitation_send_batch', 'solicitation_batch', ${fx.batchId},
      'completed', NOW() - INTERVAL '30 days', NOW() - INTERVAL '29 days',
      'attribution-632-integration'
    )
  `;
  return runId;
}

/** A TERMINAL Lazy child under the send parent — the outcome's real owner. */
async function seedLazyChild(fx: Fixture, parentRunId: string | null): Promise<string> {
  const runId = randomUUID();
  await sql()`
    INSERT INTO agent_runs (
      id, account_id, business_id, kind, subject_type, subject_id,
      status, started_at, ended_at, correlation_id, parent_run_id
    ) VALUES (
      ${runId}::uuid, ${fx.accountId}::uuid, ${fx.businessId}::uuid,
      'solicitation_ask', 'solicitation_ask', ${randomUUID()},
      'completed', NOW() - INTERVAL '30 days', NOW() - INTERVAL '29 days',
      'attribution-632-integration', ${parentRunId}::uuid
    )
  `;
  return runId;
}

interface ReviewInput {
  fixture: Fixture;
  reviewerName: string | null;
  starRating?: number;
  /** `::text` stamp, or null to exercise the detected_at fallback. */
  reviewDate: string | null;
  /** `::text` stamp. */
  detectedAt: string;
}

async function seedReview(input: ReviewInput): Promise<string> {
  const reviewId = randomUUID();
  const marker = `attribution-632-${reviewId}`;
  await sql()`
    INSERT INTO reviews (
      id, business_id, provider, provider_review_id, provider_review_name,
      provider_location_name, reviewer_name, star_rating, review_text,
      review_date, detected_at, status
    ) VALUES (
      ${reviewId}::uuid, ${input.fixture.businessId}::uuid, 'zernio',
      ${marker}, ${`zernio://attribution-632/reviews/${marker}`},
      'zernio://attribution-632/locations/1', ${input.reviewerName},
      ${input.starRating ?? 5}, 'Attribution fixture review',
      ${input.reviewDate}::timestamptz, ${input.detectedAt}::timestamptz,
      ${REVIEW_STATUS.NEW}
    )
  `;
  return reviewId;
}

// ── the call under test ─────────────────────────────────────────────────────

/**
 * `attributeReview` takes a TransactionSql, and every case honours that: a
 * compare-and-set means nothing outside `sql.begin()` under PgBouncer's
 * transaction pooling, which drops the row lock the instant a SELECT returns.
 */
async function runAttribution(
  fx: Fixture,
  reviewId: string,
  executor: postgresType.Sql = sql(),
  businessIdOverride?: string,
): Promise<AttributionMatch> {
  return executor.begin(async (tx) =>
    attributeReview(tx, {
      reviewId,
      businessId: businessIdOverride ?? fx.businessId,
    }),
  ) as Promise<AttributionMatch>;
}

// ── readers ─────────────────────────────────────────────────────────────────

interface AttributionRow {
  attributed_review_id: string | null;
  attributed_at: Date | null;
  attribution_rule: string | null;
  attribution_detail: unknown;
}

async function readAttribution(fx: Fixture, outreachId: string): Promise<AttributionRow> {
  const [row] = await sql()<AttributionRow[]>`
    SELECT attributed_review_id::text AS attributed_review_id, attributed_at,
           attribution_rule, attribution_detail
      FROM solicitation_outreach
     WHERE id = ${outreachId}::uuid
       AND account_id = ${fx.accountId}::uuid
       AND business_id = ${fx.businessId}::uuid
  `;
  if (!row) throw new Error(`outreach ${outreachId} vanished`);
  return row;
}

interface OutcomeRow {
  agent_run_id: string | null;
  outcome_kind: string;
  attributed_agent: string;
  unit_count: number;
}

async function readOutcomes(fx: Fixture): Promise<OutcomeRow[]> {
  return sql()<OutcomeRow[]>`
    SELECT agent_run_id::text AS agent_run_id, outcome_kind, attributed_agent, unit_count
      FROM agent_outcomes
     WHERE account_id = ${fx.accountId}::uuid
       AND business_id = ${fx.businessId}::uuid
     ORDER BY occurred_at
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

async function resetFixtureRows(fx: Fixture): Promise<void> {
  await sql()`DELETE FROM agent_outcomes WHERE account_id = ${fx.accountId}::uuid`;
  await sql()`DELETE FROM solicitation_outreach WHERE business_id = ${fx.businessId}::uuid`;
  await sql()`DELETE FROM solicitation_asks WHERE business_id = ${fx.businessId}::uuid`;
  await sql()`DELETE FROM solicitation_contacts WHERE business_id = ${fx.businessId}::uuid`;
  await sql()`DELETE FROM agent_runs WHERE account_id = ${fx.accountId}::uuid`;
  await sql()`DELETE FROM reviews WHERE business_id = ${fx.businessId}::uuid`;
}

/** Location-scoped teardown. The ACCOUNT outlives it — `sibling` shares one. */
async function dropFixtureLocation(fx: Fixture): Promise<void> {
  await resetFixtureRows(fx);
  await sql()`DELETE FROM solicitation_batches WHERE business_id = ${fx.businessId}::uuid`;
  await sql()`DELETE FROM contact_csv_uploads WHERE business_id = ${fx.businessId}::uuid`;
  await sql()`DELETE FROM businesses WHERE id = ${fx.businessId}::uuid`;
}

// ── the candidate query and the write transaction (Task 3) ──────────────────

describeWithDb(
  'review attribution against live local Postgres',
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
        MIGRATION_114_SOLICITATION_ATTRIBUTION,
      ]);
      const own = await seedFixture('Primary');
      fixtures.set('primary', own);
      // SAME account, second location — the only fixture that can prove the
      // business_id half of invariant #8.
      fixtures.set('sibling', await seedFixtureUnder(own.tenant, 'Sibling', false));
      fixtures.set('crossed', await seedFixture('Crossed'));
    }, LIVE_DB_LOCK_HOOK_TIMEOUT_MS);

    afterEach(async () => {
      for (const fx of fixtures.values()) {
        await resetFixtureRows(fx);
      }
    }, 60_000);

    afterAll(async () => {
      try {
        if (db) {
          const seeded = [...fixtures.values()];
          for (const fx of seeded) await dropFixtureLocation(fx);
          const tenants = new Map(seeded.map((fx) => [fx.accountId, fx.tenant]));
          for (const tenant of tenants.values()) {
            await cleanupTenantAccount(sql(), tenant);
          }
          fixtures.clear();
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

    describe('attribution', () => {
      it('attribution: the candidate query excludes bounced, complained and unknown outreach rows', async () => {
        // All three carry the MATCHING contact name, so the only thing that can
        // keep them out of the candidate set is the predicate under test.
        const fx = fixture('primary');
        const anchor = await dbStamp('1 hour');
        const detected = await dbStamp('30 minutes');

        const bounced = await seedOutreach({
          fixture: fx,
          contactName: CONTACT_NAME,
          queuedAt: stampPlus(anchor, '-2 days'),
          sentAt: stampPlus(anchor, '-2 days'),
          bouncedAt: stampPlus(anchor, '-1 day'),
        });
        const complained = await seedOutreach({
          fixture: fx,
          contactName: CONTACT_NAME,
          queuedAt: stampPlus(anchor, '-3 days'),
          sentAt: stampPlus(anchor, '-3 days'),
          complainedAt: stampPlus(anchor, '-2 days'),
        });
        // `unknown` is "possibly contacted" for over-contact purposes and
        // explicitly NOT a confirmed send (spec D12d). 091's status/timestamp
        // CHECK also forbids it a `sent_at`, so it fails two arms at once.
        const unknown = await seedOutreach({
          fixture: fx,
          contactName: CONTACT_NAME,
          deliveryStatus: 'unknown',
          dispositionReason: 'send_indeterminate',
          queuedAt: stampPlus(anchor, '-4 days'),
          sentAt: null,
        });

        const reviewId = await seedReview({
          fixture: fx,
          reviewerName: REVIEWER_NAME,
          reviewDate: anchor,
          detectedAt: detected,
        });

        expect(await runAttribution(fx, reviewId)).toEqual({ resolution: 'no_candidates' });
        for (const outreachId of [bounced, complained, unknown]) {
          const row = await readAttribution(fx, outreachId);
          expect(row.attributed_at).toBeNull();
          expect(row.attributed_review_id).toBeNull();
        }
      });

      it('attribution: the candidate query excludes rows outside the 14-day attribution window', async () => {
        // The in-window NON-matching row is the positive control: it proves the
        // 15-day row was dropped by the WINDOW, not by an empty result set.
        const fx = fixture('primary');
        const anchor = await dbStamp('1 hour');
        const detected = await dbStamp('30 minutes');

        const stale = await seedOutreach({
          fixture: fx,
          contactName: CONTACT_NAME,
          queuedAt: stampPlus(anchor, '-15 days'),
          sentAt: stampPlus(anchor, '-15 days'),
        });
        await seedOutreach({
          fixture: fx,
          contactName: OTHER_CONTACT_NAME,
          queuedAt: stampPlus(anchor, '-13 days'),
          sentAt: stampPlus(anchor, '-13 days'),
        });

        const reviewId = await seedReview({
          fixture: fx,
          reviewerName: REVIEWER_NAME,
          reviewDate: anchor,
          detectedAt: detected,
        });

        expect(await runAttribution(fx, reviewId)).toEqual({
          resolution: 'no_match',
          candidateCount: 1,
        });
        expect((await readAttribution(fx, stale)).attributed_at).toBeNull();
      });

      it('attribution: an outreach row sent exactly 14 days before the review anchor remains eligible', async () => {
        // Both ends INCLUSIVE (finding A5): the intake excludes only "MORE than
        // 14 days". Both sides derive from ONE database instant carried as text,
        // so the comparison cannot be decided by a truncated microsecond.
        const fx = fixture('primary');
        const anchor = await dbStamp('1 hour');
        const detected = await dbStamp('30 minutes');

        const outreachId = await seedOutreach({
          fixture: fx,
          contactName: CONTACT_NAME,
          queuedAt: stampPlus(anchor, '-14 days'),
          sentAt: stampPlus(anchor, '-14 days'),
        });
        const reviewId = await seedReview({
          fixture: fx,
          reviewerName: REVIEWER_NAME,
          reviewDate: anchor,
          detectedAt: detected,
        });

        const match = await runAttribution(fx, reviewId);
        expect(match.resolution).toBe('attributed');
        const row = await readAttribution(fx, outreachId);
        expect(row.attributed_review_id).toBe(reviewId);
        expect(row.attribution_rule).toBe('full_name');
      });

      it('attribution: a review anchored before sent_at never yields that outreach row as a candidate', async () => {
        // The anchor is LEAST(review_date, detected_at): this review was POSTED
        // three days ago and detected two days ago, and the ask went out two
        // days ago — after the review existed, so it cannot have caused it.
        const fx = fixture('primary');
        const reviewDate = await dbStamp('3 days');
        const detected = await dbStamp('2 days');

        const outreachId = await seedOutreach({
          fixture: fx,
          contactName: CONTACT_NAME,
          queuedAt: stampPlus(reviewDate, '1 day'),
          sentAt: stampPlus(reviewDate, '1 day'),
        });
        const reviewId = await seedReview({
          fixture: fx,
          reviewerName: REVIEWER_NAME,
          reviewDate,
          detectedAt: detected,
        });

        expect(await runAttribution(fx, reviewId)).toEqual({ resolution: 'no_candidates' });
        expect((await readAttribution(fx, outreachId)).attributed_at).toBeNull();
      });

      it('attribution: a null review_date uses detected_at as the candidate-window anchor', async () => {
        // LEAST ignores NULLs, so a review with no provider date anchors on
        // detected_at. A hand-rolled `review_date`-only anchor would make every
        // comparison NULL and drop the whole candidate set. The second row —
        // sent two hours AFTER detected_at — is what proves the anchor is real:
        // `candidate_count` stays 1.
        const fx = fixture('primary');
        const detected = await dbStamp('1 hour');

        const outreachId = await seedOutreach({
          fixture: fx,
          contactName: CONTACT_NAME,
          queuedAt: stampPlus(detected, '-13 days'),
          sentAt: stampPlus(detected, '-13 days'),
        });
        await seedOutreach({
          fixture: fx,
          contactName: OTHER_CONTACT_NAME,
          queuedAt: stampPlus(detected, '2 hours'),
          sentAt: stampPlus(detected, '2 hours'),
        });

        const reviewId = await seedReview({
          fixture: fx,
          reviewerName: REVIEWER_NAME,
          reviewDate: null,
          detectedAt: detected,
        });

        const match = await runAttribution(fx, reviewId);
        expect(match.resolution).toBe('attributed');
        const row = await readAttribution(fx, outreachId);
        expect(row.attributed_review_id).toBe(reviewId);
        expect(jsonObject(row.attribution_detail).candidate_count).toBe(1);
      });

      it('attribution: an unsubscribed outreach row is still a candidate', async () => {
        // Locked decision, not an oversight: an unsubscribe is evidence the mail
        // was OPENED, and unsubscribing and reviewing happen in either order.
        const fx = fixture('primary');
        const anchor = await dbStamp('1 hour');
        const detected = await dbStamp('30 minutes');

        const outreachId = await seedOutreach({
          fixture: fx,
          contactName: CONTACT_NAME,
          queuedAt: stampPlus(anchor, '-2 days'),
          sentAt: stampPlus(anchor, '-2 days'),
          unsubscribedAt: stampPlus(anchor, '-1 day'),
        });
        const reviewId = await seedReview({
          fixture: fx,
          reviewerName: REVIEWER_NAME,
          reviewDate: anchor,
          detectedAt: detected,
        });

        expect((await runAttribution(fx, reviewId)).resolution).toBe('attributed');
        expect((await readAttribution(fx, outreachId)).attributed_review_id).toBe(reviewId);
      });

      it('attribution: an already-attributed outreach row is never a candidate for a second review', async () => {
        const fx = fixture('primary');
        const anchor = await dbStamp('1 hour');
        const detected = await dbStamp('30 minutes');

        const outreachId = await seedOutreach({
          fixture: fx,
          contactName: CONTACT_NAME,
          queuedAt: stampPlus(anchor, '-2 days'),
          sentAt: stampPlus(anchor, '-2 days'),
        });
        const first = await seedReview({
          fixture: fx,
          reviewerName: REVIEWER_NAME,
          reviewDate: anchor,
          detectedAt: detected,
        });
        expect((await runAttribution(fx, first)).resolution).toBe('attributed');

        const second = await seedReview({
          fixture: fx,
          reviewerName: REVIEWER_NAME,
          reviewDate: anchor,
          detectedAt: detected,
        });
        expect(await runAttribution(fx, second)).toEqual({ resolution: 'no_candidates' });
        expect((await readAttribution(fx, outreachId)).attributed_review_id).toBe(first);
      });

      it('attribution: deleting an attributed review does not make its outreach row eligible for another review', async () => {
        // Finding A3, the whole reason the marker is `attributed_at`. The FK is
        // ON DELETE SET NULL, so deleting the review nulls the review id and
        // leaves the timestamp — a candidate query keyed on the id would
        // resurrect this row and overwrite retained provenance.
        const fx = fixture('primary');
        const anchor = await dbStamp('1 hour');
        const detected = await dbStamp('30 minutes');

        const outreachId = await seedOutreach({
          fixture: fx,
          contactName: CONTACT_NAME,
          queuedAt: stampPlus(anchor, '-2 days'),
          sentAt: stampPlus(anchor, '-2 days'),
        });
        const first = await seedReview({
          fixture: fx,
          reviewerName: REVIEWER_NAME,
          reviewDate: anchor,
          detectedAt: detected,
        });
        expect((await runAttribution(fx, first)).resolution).toBe('attributed');

        await sql()`
          DELETE FROM reviews
           WHERE id = ${first}::uuid AND business_id = ${fx.businessId}::uuid
        `;
        const afterDelete = await readAttribution(fx, outreachId);
        expect(afterDelete.attributed_review_id).toBeNull();
        expect(afterDelete.attributed_at).not.toBeNull();

        const second = await seedReview({
          fixture: fx,
          reviewerName: REVIEWER_NAME,
          reviewDate: anchor,
          detectedAt: detected,
        });
        expect(await runAttribution(fx, second)).toEqual({ resolution: 'no_candidates' });

        const afterSecond = await readAttribution(fx, outreachId);
        expect(afterSecond.attributed_review_id).toBeNull();
        expect(afterSecond.attributed_at).toEqual(afterDelete.attributed_at);
        expect(afterSecond.attribution_rule).toBe('full_name');
      });

      it('attribution: the handler writes the attribution columns and the review_attributed outcome in one transaction', async () => {
        const fx = fixture('primary');
        const anchor = await dbStamp('1 hour');
        const detected = await dbStamp('30 minutes');
        const childRunId = await seedLazyChild(fx, null);

        const outreachId = await seedOutreach({
          fixture: fx,
          contactName: CONTACT_NAME,
          queuedAt: stampPlus(anchor, '-2 days'),
          sentAt: stampPlus(anchor, '-2 days'),
          agentRunId: childRunId,
        });
        const reviewId = await seedReview({
          fixture: fx,
          reviewerName: REVIEWER_NAME,
          reviewDate: anchor,
          detectedAt: detected,
        });

        expect((await runAttribution(fx, reviewId)).resolution).toBe('attributed');

        const row = await readAttribution(fx, outreachId);
        expect(row.attributed_review_id).toBe(reviewId);
        expect(row.attributed_at).not.toBeNull();
        expect(row.attribution_rule).toBe('full_name');

        const detail = jsonObject(row.attribution_detail);
        expect(detail).toMatchObject({
          rule: 'full_name',
          matcher_version: 'attribution_v1',
          star_rating: 5,
          candidate_count: 1,
        });
        expect(typeof detail.sent_at).toBe('string');
        // Deviation D2 — no personal data survives here. The review's own
        // deletion must not leave a reviewer or contact name behind.
        const serialized = JSON.stringify(detail).toLowerCase();
        expect(serialized).not.toContain('dana');
        expect(serialized).not.toContain('rodriguez');

        expect(await readOutcomes(fx)).toEqual([
          {
            agent_run_id: childRunId,
            outcome_kind: 'review_attributed',
            attributed_agent: 'solicitation',
            unit_count: 1,
          },
        ]);
      });

      it('attribution: an outcome-write failure rolls back the outreach attribution columns', async () => {
        // The poison is ITSELF a failing outcome write: an `agent_outcomes`
        // INSERT whose `agent_run_id` names no run, so Postgres raises 23503 and
        // the transaction enters aborted state. A JS throw would not — the
        // failure has to originate in Postgres (abort-injection's contract).
        const fx = fixture('primary');
        const anchor = await dbStamp('1 hour');
        const detected = await dbStamp('30 minutes');
        const childRunId = await seedLazyChild(fx, null);

        const outreachId = await seedOutreach({
          fixture: fx,
          contactName: CONTACT_NAME,
          queuedAt: stampPlus(anchor, '-2 days'),
          sentAt: stampPlus(anchor, '-2 days'),
          agentRunId: childRunId,
        });
        const reviewId = await seedReview({
          fixture: fx,
          reviewerName: REVIEWER_NAME,
          reviewDate: anchor,
          detectedAt: detected,
        });

        const failingOutcomeWrite = (tx: postgresType.TransactionSql) => tx`
          INSERT INTO agent_outcomes (
            id, account_id, business_id, agent_run_id,
            attributed_agent, outcome_kind, unit_count
          ) VALUES (
            ${randomUUID()}::uuid, ${fx.accountId}::uuid, ${fx.businessId}::uuid,
            ${randomUUID()}::uuid, 'solicitation', 'review_attributed', 1
          )
        `;

        await expect(
          runAttribution(fx, reviewId, abortingExecutor(sql(), failingOutcomeWrite)),
        ).rejects.toThrow();

        const row = await readAttribution(fx, outreachId);
        expect(row.attributed_review_id).toBeNull();
        expect(row.attributed_at).toBeNull();
        expect(row.attribution_rule).toBeNull();
        expect(row.attribution_detail).toBeNull();
        expect(await readOutcomes(fx)).toEqual([]);
      });

      it('attribution: re-running the handler for the same review is idempotent and emits exactly one outcome', async () => {
        const fx = fixture('primary');
        const anchor = await dbStamp('1 hour');
        const detected = await dbStamp('30 minutes');
        const childRunId = await seedLazyChild(fx, null);

        const outreachId = await seedOutreach({
          fixture: fx,
          contactName: CONTACT_NAME,
          queuedAt: stampPlus(anchor, '-2 days'),
          sentAt: stampPlus(anchor, '-2 days'),
          agentRunId: childRunId,
        });
        const reviewId = await seedReview({
          fixture: fx,
          reviewerName: REVIEWER_NAME,
          reviewDate: anchor,
          detectedAt: detected,
        });

        expect((await runAttribution(fx, reviewId)).resolution).toBe('attributed');
        const firstRead = await readAttribution(fx, outreachId);

        // The replay sees its own marker: `attributed_at` is set, so the row is
        // out of the candidate set permanently.
        expect(await runAttribution(fx, reviewId)).toEqual({ resolution: 'no_candidates' });

        const secondRead = await readAttribution(fx, outreachId);
        expect(secondRead.attributed_review_id).toBe(reviewId);
        expect(secondRead.attributed_at).toEqual(firstRead.attributed_at);

        const [row] = await sql()<{ count: number }[]>`
          SELECT COUNT(*)::int AS count FROM agent_outcomes
           WHERE account_id = ${fx.accountId}::uuid
             AND business_id = ${fx.businessId}::uuid
             AND outcome_kind = 'review_attributed'
        `;
        expect(row?.count).toBe(1);
      });

      it('attribution: attribution is sentiment-blind — a one-star review attributes like a five-star review', async () => {
        // D16's shadow metric measures whether an ask produced a REVIEW, not a
        // good one. A rating filter here would quietly turn the metric into
        // "asks that produced praise" and flatter the send lane.
        const fx = fixture('primary');
        const results: { resolution: string; rule: string | null; star: unknown }[] = [];

        for (const starRating of [1, 5]) {
          const anchor = await dbStamp('1 hour');
          const detected = await dbStamp('30 minutes');
          const outreachId = await seedOutreach({
            fixture: fx,
            contactName: CONTACT_NAME,
            queuedAt: stampPlus(anchor, '-2 days'),
            sentAt: stampPlus(anchor, '-2 days'),
          });
          const reviewId = await seedReview({
            fixture: fx,
            reviewerName: REVIEWER_NAME,
            starRating,
            reviewDate: anchor,
            detectedAt: detected,
          });

          const match = await runAttribution(fx, reviewId);
          const row = await readAttribution(fx, outreachId);
          expect(row.attributed_review_id).toBe(reviewId);
          results.push({
            resolution: match.resolution,
            rule: row.attribution_rule,
            star: jsonObject(row.attribution_detail).star_rating,
          });
          await resetFixtureRows(fx);
        }

        expect(results).toEqual([
          { resolution: 'attributed', rule: 'full_name', star: 1 },
          { resolution: 'attributed', rule: 'full_name', star: 5 },
        ]);
      });

      it('attribution: a matched outreach row with a null agent_run_id writes columns and skips the outcome', async () => {
        // 091 comments the column as OPTIONAL lazy-child attribution, and its FK
        // is ON DELETE SET NULL so outreach facts outlive 180-day run archival.
        // `recordOutcome` requires a real run id, so the columns still land and
        // the outcome is simply not emitted.
        const fx = fixture('primary');
        const anchor = await dbStamp('1 hour');
        const detected = await dbStamp('30 minutes');

        const outreachId = await seedOutreach({
          fixture: fx,
          contactName: CONTACT_NAME,
          queuedAt: stampPlus(anchor, '-2 days'),
          sentAt: stampPlus(anchor, '-2 days'),
          agentRunId: null,
        });
        const reviewId = await seedReview({
          fixture: fx,
          reviewerName: REVIEWER_NAME,
          reviewDate: anchor,
          detectedAt: detected,
        });

        expect((await runAttribution(fx, reviewId)).resolution).toBe('attributed');
        const row = await readAttribution(fx, outreachId);
        expect(row.attributed_review_id).toBe(reviewId);
        expect(row.attribution_rule).toBe('full_name');
        expect(await readOutcomes(fx)).toEqual([]);
      });

      it('attribution: review_attributed attaches to the matched terminal Lazy child, never its parent', async () => {
        const fx = fixture('primary');
        const anchor = await dbStamp('1 hour');
        const detected = await dbStamp('30 minutes');
        const parentRunId = await seedSendParent(fx);
        const childRunId = await seedLazyChild(fx, parentRunId);

        await seedOutreach({
          fixture: fx,
          contactName: CONTACT_NAME,
          queuedAt: stampPlus(anchor, '-2 days'),
          sentAt: stampPlus(anchor, '-2 days'),
          agentRunId: childRunId,
        });
        const reviewId = await seedReview({
          fixture: fx,
          reviewerName: REVIEWER_NAME,
          reviewDate: anchor,
          detectedAt: detected,
        });

        expect((await runAttribution(fx, reviewId)).resolution).toBe('attributed');

        // The child really is the TERMINAL Lazy child of that parent.
        const [child] = await sql()<{ status: string; parent_run_id: string | null }[]>`
          SELECT status, parent_run_id::text AS parent_run_id FROM agent_runs
           WHERE id = ${childRunId}::uuid AND account_id = ${fx.accountId}::uuid
        `;
        expect(child).toMatchObject({ status: 'completed', parent_run_id: parentRunId });

        const outcomes = await readOutcomes(fx);
        expect(outcomes).toHaveLength(1);
        expect(outcomes[0]!.agent_run_id).toBe(childRunId);
        expect(outcomes.some((outcome) => outcome.agent_run_id === parentRunId)).toBe(false);
      });
    });

    // ── the shadow / never-billed claim (Task 3) ────────────────────────────

    describe('attributeReview', () => {
      it('attributeReview: a successful attribution writes no api_costs, Stripe or metered-usage record', async () => {
        // Map #617 decision 1 keeps this metric shadow / no-charge: the outcome
        // is an attribution fact, never a billable unit. `agent_outcomes` is the
        // ONLY sink, and the module has no billing surface to reach for.
        const fx = fixture('primary');
        const anchor = await dbStamp('1 hour');
        const detected = await dbStamp('30 minutes');
        const childRunId = await seedLazyChild(fx, null);

        await seedOutreach({
          fixture: fx,
          contactName: CONTACT_NAME,
          queuedAt: stampPlus(anchor, '-2 days'),
          sentAt: stampPlus(anchor, '-2 days'),
          agentRunId: childRunId,
        });
        const reviewId = await seedReview({
          fixture: fx,
          reviewerName: REVIEWER_NAME,
          reviewDate: anchor,
          detectedAt: detected,
        });

        expect((await runAttribution(fx, reviewId)).resolution).toBe('attributed');
        expect(await readOutcomes(fx)).toHaveLength(1);

        const [costs] = await sql()<{ count: number }[]>`
          SELECT COUNT(*)::int AS count FROM api_costs
           WHERE account_id = ${fx.accountId}::uuid
              OR business_id = ${fx.businessId}::uuid
        `;
        expect(costs?.count).toBe(0);

        const [rollups] = await sql()<{ count: number }[]>`
          SELECT COUNT(*)::int AS count FROM api_costs_daily_rollups
           WHERE business_id = ${fx.businessId}::uuid
        `;
        expect(rollups?.count).toBe(0);

        // There is no metered-usage table in this schema and no Stripe call in
        // this lane; the source pin is what stops a future edit from adding one
        // without anybody noticing this claim went stale.
        const source = readFileSync(MODULE_PATH, 'utf8').toLowerCase();
        for (const banned of ['stripe', 'api_costs', 'metered', 'usage_record']) {
          expect(source).not.toContain(banned);
        }
      });
    });

    // ── invariant #8: every read and write scoped by account and business ───

    describe('tenant isolation', () => {
      it('tenant isolation: crossed account, business, review and outreach ids expose or mutate neither tenant', async () => {
        // Both halves of invariant #8 get their own decoy. `sibling` is a
        // SECOND LOCATION under the SAME account — an account-only scope would
        // swallow its row — and `crossed` is a different account entirely.
        const own = fixture('primary');
        const sibling = fixture('sibling');
        const other = fixture('crossed');
        const anchor = await dbStamp('1 hour');
        const detected = await dbStamp('30 minutes');

        const decoys: [Fixture, string][] = [];
        for (const decoy of [sibling, other]) {
          decoys.push([
            decoy,
            await seedOutreach({
              fixture: decoy,
              contactName: CONTACT_NAME,
              queuedAt: stampPlus(anchor, '-2 days'),
              sentAt: stampPlus(anchor, '-2 days'),
              agentRunId: await seedLazyChild(decoy, null),
            }),
          ]);
        }

        const otherReview = await seedReview({
          fixture: other,
          reviewerName: REVIEWER_NAME,
          reviewDate: anchor,
          detectedAt: detected,
        });
        const ownReview = await seedReview({
          fixture: own,
          reviewerName: REVIEWER_NAME,
          reviewDate: anchor,
          detectedAt: detected,
        });

        // 1. Neither decoy is visible, though both match perfectly.
        expect(await runAttribution(own, ownReview)).toEqual({ resolution: 'no_candidates' });

        // 2. Crossed review + business, both directions: the review lookup is
        //    scoped by business_id, so neither pairing resolves.
        await expect(
          runAttribution(own, otherReview, sql(), own.businessId),
        ).rejects.toThrow(/not found for business/);
        await expect(
          runAttribution(other, ownReview, sql(), other.businessId),
        ).rejects.toThrow(/not found for business/);
        await expect(
          runAttribution(own, ownReview, sql(), sibling.businessId),
        ).rejects.toThrow(/not found for business/);

        // 3. The owning location's own row attributes, and nothing crosses.
        const ownOutreach = await seedOutreach({
          fixture: own,
          contactName: CONTACT_NAME,
          queuedAt: stampPlus(anchor, '-2 days'),
          sentAt: stampPlus(anchor, '-2 days'),
          agentRunId: await seedLazyChild(own, null),
        });
        expect((await runAttribution(own, ownReview)).resolution).toBe('attributed');

        expect((await readAttribution(own, ownOutreach)).attributed_review_id).toBe(ownReview);
        for (const [decoy, outreachId] of decoys) {
          const row = await readAttribution(decoy, outreachId);
          expect(row.attributed_review_id).toBeNull();
          expect(row.attributed_at).toBeNull();
          expect(await readOutcomes(decoy)).toEqual([]);
        }
        expect(await readOutcomes(own)).toHaveLength(1);
      });
    });
  },
);

// ── the owner read model (Task 6) ───────────────────────────────────────────

describe('listAttributedReviews', () => {
  it.todo('listAttributedReviews: returns matches across batches within the last 30 days');
  it.todo('listAttributedReviews: excludes attribution older than 30 days');
  it.todo('listAttributedReviews: scopes every read by account_id and business_id');
  it.todo('listAttributedReviews: returns an empty list when SOLICITATION_SEND_ENABLED is off');
});
