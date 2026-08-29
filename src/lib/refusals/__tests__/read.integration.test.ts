// The Refusal Log eval — live-DB read half (T0 red-first, S5 arm filled in by T2).
//
// Titles are VERBATIM from the intake's `tests_to_add`; the `promised-tests`
// gate row matches them as fixed strings.
//
// WHY THIS FILE IS NAMED `*.integration.test.ts`. That glob is what puts a
// suite in vitest's serialized `integration` project (vitest.config.ts). Every
// case below reaches the shared local Postgres, and a live-DB suite that misses
// the suffix runs in the fully parallel project alongside every other live-DB
// writer — the #573 deadlock. The name is load-bearing.
//
// Run it:
//   TEST_DATABASE_POOL_URL=postgres://…localhost… \
//     pnpm vitest run src/lib/refusals/__tests__/read.integration.test.ts
//
// TWO CONVENTIONS THE BODIES KEEP (`.claude/CLAUDE.md`, enforced by
// `pnpm ci:live-db-suites`):
//   1. No run-time DDL. The schema is provisioned once by `pnpm test:db:setup`;
//      asserted below with `assertSchemaReady`, never applied here.
//   2. Enrol in the cross-process lock (`acquireLiveDbLock`) before seeding —
//      these fixtures write `solicitation_*`, `flagged_responses`,
//      `approval_audit_log` and `account_audit_log`, all of which sibling
//      suites truncate.
// Precedent copied for the tenant fixtures, the lock and the local-host
// refusal guard: `src/lib/solicitation/__tests__/batch-view.integration.test.ts`.
//
// T2 landed `src/lib/refusals/read.ts` carrying the S5 arm
// (`solicitation_asks`), so the S5, window-boundary and empty-result cases are
// REAL. Every case keyed on S1, S3, S4, S6 or S7 stays `it.todo` until T3/T4
// add those arms to the same `UNION ALL`.
//
// WHY THE CLOCK IS FROZEN. `getRefusalLog` derives its window from `new Date()`
// at call time (like `getAgentTeamSummary`), and the boundary cases assert
// inclusion at EXACTLY the window start — unobservable against a moving clock.
// `vi.useFakeTimers({ toFake: ['Date'] })` pins Date and nothing else, so
// postgres.js's own timeouts still run on real time (precedent:
// `worker/background/schedulers/__tests__/RankingTrackingScheduler.integration.test.ts:79`).
// Every seeded stamp is therefore an explicit `::timestamptz`, never `NOW()`.
//
// PER-ARM PROOF (plan §6 T4, intake invariant 1). The read is ONE `UNION ALL`,
// so a structural assertion over the combined SQL cannot prove any single arm is
// scoped. Every arm therefore carries its own behavioural foreign-account or
// foreign-location negative-row case below; do not collapse them.

import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import type postgresType from 'postgres';
import { describeWithDb } from '@/__tests__/helpers/describe-with-db';
import {
  cleanupLocation,
  cleanupTenantAccount,
  seedLocation,
  seedTenantAccount,
  type TenantSeed,
} from '@/lib/shared/__tests__/live-db-tenant';
import {
  acquireLiveDbLock,
  assertLocalTestDatabaseUrl,
  LIVE_DB_LOCK_HOOK_TIMEOUT_MS,
  type LiveDbLock,
} from '@/lib/shared/__tests__/helpers/live-db-lock';
import {
  assertSchemaReady,
  MIGRATION_088_SOLICITATION_BATCH_EXECUTOR,
  MIGRATION_090_SOLICITATION_ASK_EVIDENCE,
} from '@/lib/shared/__tests__/helpers/schema-ready';
import { seedContactCsvUpload } from '@/lib/shared/__tests__/helpers/outreach-fixture';
// The stored `approval_audit_log.action` literals, from their single owner —
// never re-spelled here, exactly as `src/lib/refusals/vocabulary.ts` imports them.
import {
  AUDIT_ACTION_AUTO_POLICY_REVOKED_JUDGE_UNAVAILABLE,
  AUDIT_ACTION_AUTO_POLICY_REVOKED_POLICY_SUSPENDED,
} from '@/lib/approval/audit';
import { getRefusalLog, type RefusalEntry, type RefusalLog } from '../read';

const testDatabaseUrl = process.env.TEST_DATABASE_POOL_URL;

let db: postgresType.Sql | undefined;
let tenant: TenantSeed | undefined;
let otherTenant: TenantSeed | undefined;
let featureDatabaseLock: LiveDbLock | undefined;

const businessId = randomUUID();
/** A SECOND location under the SAME account — the boundary a bare `account_id = …` would wrongly pass. */
const siblingBusinessId = randomUUID();
/**
 * A location under the OTHER account. The cross-tenant join cases need a real
 * foreign review and a real foreign response for a correctly scoped root row to
 * point at — `flagged_responses` and `approval_audit_log` carry independent FKs
 * (051:15), so that drift is representable in the schema.
 */
const foreignBusinessId = randomUUID();

/** The instant every case pretends is "now". Window arithmetic is derived, never guessed. */
const NOW = new Date('2026-08-20T12:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;

// Owner-unsafe strings, seeded so the redaction case asserts on ABSENCE of real
// values rather than on a label looking right. `flagged_responses.reason` is
// moderation prose that may never leave the server (intake invariant 4).
const FLAG_REASON = 'MODERATION-PROSE-must-never-leave-the-server';
const DRAFT_TEXT = 'DRAFT-TEXT-must-never-reach-the-refusal-log';
const REVIEW_TEXT = 'REVIEW-TEXT-must-never-reach-the-refusal-log';

/** The `>=` boundary `getRefusalLog` computes for a window of `windowDays` at {@link NOW}. */
function windowStart(windowDays: number): Date {
  return new Date(NOW.getTime() - windowDays * DAY_MS);
}

function sql(): postgresType.Sql {
  if (!db) throw new Error('refusal log integration database was not initialized');
  return db;
}

async function seedUpload(business: string): Promise<string> {
  return seedContactCsvUpload(sql(), {
    accountId: tenant!.accountId,
    businessId: business,
    attestedByUserId: tenant!.userId,
    filename: `refusal-log-${randomUUID()}.csv`,
    report: { accepted: 0 },
  });
}

/** One batch plus the upload it needs (`source_upload_id` is UNIQUE). */
async function seedBatch(business: string): Promise<string> {
  const batchId = randomUUID();
  const uploadId = await seedUpload(business);
  await sql()`
    INSERT INTO solicitation_batches (id, account_id, business_id, source_upload_id)
    VALUES (${batchId}::uuid, ${tenant!.accountId}::uuid, ${business}::uuid, ${uploadId}::uuid)
  `;
  return batchId;
}

async function seedContact(business: string): Promise<string> {
  const contactId = randomUUID();
  const uploadId = await seedUpload(business);
  await sql()`
    INSERT INTO solicitation_contacts (id, business_id, name, email, created_by_upload_id)
    VALUES (${contactId}::uuid, ${business}::uuid, 'Refusal Log Contact',
            ${`refusal-${contactId}@example.com`}, ${uploadId}::uuid)
  `;
  return contactId;
}

/**
 * One withheld ask on its own batch and contact, stamped explicitly.
 *
 * `evidence` mirrors the columns because migration 090 CHECKs exactly that
 * (`evidence->>'decision'` IS NOT DISTINCT FROM `status`, same for `reason`) —
 * a fixture that skipped it would fail on a constraint no case is about.
 */
async function seedWithheldAsk(input: {
  business?: string;
  reason: string;
  decidedAt: Date;
}): Promise<string> {
  const business = input.business ?? businessId;
  const askId = randomUUID();
  const batchId = await seedBatch(business);
  const contactId = await seedContact(business);
  await sql()`
    INSERT INTO solicitation_asks
      (id, account_id, business_id, batch_id, contact_id, status, withheld_reason,
       evidence, decided_at)
    VALUES
      (${askId}::uuid, ${tenant!.accountId}::uuid, ${business}::uuid,
       ${batchId}::uuid, ${contactId}::uuid, 'withhold', ${input.reason},
       ${sql().json({ decision: 'withhold', reason: input.reason })},
       ${input.decidedAt.toISOString()}::timestamptz)
  `;
  return askId;
}

/** One review under `business`, carrying owner-unsafe body text on purpose. */
async function seedReview(business: string): Promise<string> {
  const reviewId = randomUUID();
  await sql()`
    INSERT INTO reviews (
      id, business_id, provider, provider_review_id, provider_review_name,
      provider_location_name, reviewer_name, star_rating, review_text,
      review_date, detected_at, status
    ) VALUES (
      ${reviewId}::uuid, ${business}::uuid, 'zernio',
      ${`refusal-${reviewId}`}, ${`zernio://refusal/reviews/${reviewId}`},
      'zernio://refusal/locations/1', 'Refusal Log Customer',
      2, ${REVIEW_TEXT},
      ${new Date(NOW.getTime() - 10 * DAY_MS).toISOString()}::timestamptz,
      ${new Date(NOW.getTime() - 10 * DAY_MS).toISOString()}::timestamptz,
      'pending_approval'
    )
  `;
  return reviewId;
}

/**
 * One draft reply under `business`. `pending_approval` keeps it outside
 * `responses_approval_method_required` (068) while still carrying the
 * `auto_policy` method a downgraded row really has.
 */
async function seedDraftResponse(business: string, reviewId: string): Promise<string> {
  const responseId = randomUUID();
  await sql()`
    INSERT INTO responses (
      id, review_id, business_id, response_text, original_draft_text,
      response_language, version, status, approval_method
    ) VALUES (
      ${responseId}::uuid, ${reviewId}::uuid, ${business}::uuid,
      ${DRAFT_TEXT}, ${DRAFT_TEXT}, 'en', 1, 'pending_approval', 'auto_policy'
    )
  `;
  return responseId;
}

interface HeldDraftSeed {
  flagId: string;
  reviewId: string;
  responseId: string;
}

/**
 * One `high`-severity held draft, with its own review + draft reply.
 *
 * `created_at` is set explicitly: the suite freezes Date in JS, but the
 * database clock keeps running, so a DEFAULT NOW() row would land outside every
 * derived window.
 */
async function seedHeldDraft(input: {
  business?: string;
  accountId?: string;
  /** The review the FLAG names. Defaults to this draft's own review. */
  flaggedReviewId?: string;
  severity?: 'high' | 'medium' | 'low';
  createdAt: Date;
}): Promise<HeldDraftSeed> {
  const business = input.business ?? businessId;
  const reviewId = await seedReview(business);
  const responseId = await seedDraftResponse(business, reviewId);
  const flagId = randomUUID();
  await sql()`
    INSERT INTO flagged_responses (
      id, response_id, account_id, business_id, review_id,
      source, reason, severity, status, created_at
    ) VALUES (
      ${flagId}::uuid, ${responseId}::uuid,
      ${input.accountId ?? tenant!.accountId}::uuid, ${business}::uuid,
      ${input.flaggedReviewId ?? reviewId}::uuid,
      'local_regex', ${FLAG_REASON}, ${input.severity ?? 'high'}, 'open',
      ${input.createdAt.toISOString()}::timestamptz
    )
  `;
  return { flagId, reviewId, responseId };
}

interface DowngradeSeed {
  auditId: string;
  reviewId: string;
  responseId: string;
}

/** One `approval_audit_log` revocation row, with its own review + draft reply. */
async function seedDowngrade(input: {
  business?: string;
  accountId?: string;
  /** The response the AUDIT ROW names. Defaults to a freshly seeded one. */
  responseId?: string;
  reviewId?: string;
  action: string;
  createdAt: Date;
}): Promise<DowngradeSeed> {
  const business = input.business ?? businessId;
  const reviewId = input.reviewId ?? (await seedReview(business));
  const responseId = input.responseId ?? (await seedDraftResponse(business, reviewId));
  const auditId = randomUUID();
  await sql()`
    INSERT INTO approval_audit_log (
      id, response_id, business_id, account_id, action, auth_method, created_at
    ) VALUES (
      ${auditId}::uuid, ${responseId}::uuid, ${business}::uuid,
      ${input.accountId ?? tenant!.accountId}::uuid, ${input.action}, 'auto_policy',
      ${input.createdAt.toISOString()}::timestamptz
    )
  `;
  return { auditId, reviewId, responseId };
}

function accountScope(): Parameters<typeof getRefusalLog>[1] {
  return { kind: 'account', accountId: tenant!.accountId };
}

function locationScope(business = businessId): Parameters<typeof getRefusalLog>[1] {
  return { kind: 'location', accountId: tenant!.accountId, businessId: business };
}

/** Every entry id in the log, in returned order — what the ordering cases assert on. */
function entryIds(log: RefusalLog): string[] {
  return log.categories.flatMap((group) => group.entries.map((entry) => entry.id));
}

/** Every entry in the log, flattened, for the per-entry shape assertions. */
function allEntries(log: RefusalLog): RefusalEntry[] {
  return log.categories.flatMap((group) => group.entries);
}

describeWithDb('getRefusalLog against live local Postgres', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    const databaseUrl = assertLocalTestDatabaseUrl(testDatabaseUrl);
    featureDatabaseLock = await acquireLiveDbLock(databaseUrl);
    db = postgres(databaseUrl, { max: 2, prepare: false });
    await assertSchemaReady(db, [
      MIGRATION_088_SOLICITATION_BATCH_EXECUTOR,
      MIGRATION_090_SOLICITATION_ASK_EVIDENCE,
    ]);
    tenant = await seedTenantAccount(db, {
      userName: 'Refusal Log Integration Owner',
      accountDisplayName: 'Refusal Log Integration Account',
    });
    otherTenant = await seedTenantAccount(db, {
      userName: 'Refusal Log Foreign Owner',
      accountDisplayName: 'Refusal Log Foreign Account',
    });
    await seedLocation(db, tenant.accountId, {
      businessId,
      name: 'Refusal Log Integration Location',
      isPrimary: true,
    });
    // `is_primary` stays FALSE: businesses_account_primary_uniq allows one
    // primary per account and the location above already claimed it.
    await seedLocation(db, tenant.accountId, {
      businessId: siblingBusinessId,
      name: 'Refusal Log Sibling Location',
      isPrimary: false,
    });
    await seedLocation(db, otherTenant.accountId, {
      businessId: foreignBusinessId,
      name: 'Refusal Log Foreign Location',
      isPrimary: true,
    });
  }, LIVE_DB_LOCK_HOOK_TIMEOUT_MS);

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });

  afterEach(async () => {
    vi.useRealTimers();
    const businesses = [businessId, siblingBusinessId];
    await sql()`DELETE FROM solicitation_asks WHERE business_id = ANY(${businesses}::uuid[])`;
    await sql()`DELETE FROM solicitation_batches WHERE business_id = ANY(${businesses}::uuid[])`;
    await sql()`DELETE FROM solicitation_contacts WHERE business_id = ANY(${businesses}::uuid[])`;
    await sql()`DELETE FROM contact_csv_uploads WHERE business_id = ANY(${businesses}::uuid[])`;

    // The review/response lanes, foreign location included: a cross-tenant case
    // deliberately writes a row of ours pointing at the other account's data.
    // Explicit deletes first, so a row whose OWN business is in scope but whose
    // child hangs off another one still goes; `reviews` then cascades the rest.
    const reviewLaneBusinesses = [businessId, siblingBusinessId, foreignBusinessId];
    await sql()`DELETE FROM flagged_responses WHERE business_id = ANY(${reviewLaneBusinesses}::uuid[])`;
    await sql()`DELETE FROM approval_audit_log WHERE business_id = ANY(${reviewLaneBusinesses}::uuid[])`;
    await sql()`DELETE FROM responses WHERE business_id = ANY(${reviewLaneBusinesses}::uuid[])`;
    await sql()`DELETE FROM reviews WHERE business_id = ANY(${reviewLaneBusinesses}::uuid[])`;
  });

  // Release in the reverse of acquisition order, and on every path: a
  // `beforeAll` that failed after taking the lock still holds it, and a leaked
  // advisory lock blocks every other live-DB suite until the session dies.
  afterAll(async () => {
    try {
      if (db) {
        await cleanupLocation(db, foreignBusinessId);
        await cleanupLocation(db, siblingBusinessId);
        await cleanupLocation(db, businessId);
        if (tenant) await cleanupTenantAccount(db, tenant);
        if (otherTenant) await cleanupTenantAccount(db, otherTenant);
        await db.end({ timeout: 5 });
      }
    } finally {
      await featureDatabaseLock?.release();
    }
  }, LIVE_DB_LOCK_HOOK_TIMEOUT_MS);

  describe('getRefusalLog tenant isolation', () => {
    // S1 is deny-all RLS read through the RLS-bypassing `postgres` role, so
    // these two cases ARE its access control (plan §7 risk 1, invariant #8).
    it('getRefusalLog never returns a held-draft row from another account', async () => {
      const mine = await seedHeldDraft({ createdAt: new Date(NOW.getTime() - DAY_MS) });
      const foreign = await seedHeldDraft({
        business: foreignBusinessId,
        accountId: otherTenant!.accountId,
        createdAt: new Date(NOW.getTime() - 2 * DAY_MS),
      });

      const log = await getRefusalLog(sql(), accountScope(), '30d');
      expect(entryIds(log)).toEqual([mine.flagId]);

      // The foreign hold really exists — the account scope excluded it, rather
      // than the fixture never having written it.
      const theirs = await getRefusalLog(
        sql(),
        { kind: 'account', accountId: otherTenant!.accountId },
        '30d',
      );
      expect(entryIds(theirs)).toEqual([foreign.flagId]);
    });

    it('getRefusalLog never returns a held-draft row from another location', async () => {
      const mine = await seedHeldDraft({ createdAt: new Date(NOW.getTime() - DAY_MS) });
      const sibling = await seedHeldDraft({
        business: siblingBusinessId,
        createdAt: new Date(NOW.getTime() - 2 * DAY_MS),
      });

      const scoped = await getRefusalLog(sql(), locationScope(), '30d');
      expect(entryIds(scoped)).toEqual([mine.flagId]);

      const aggregate = await getRefusalLog(sql(), accountScope(), '30d');
      expect(entryIds(aggregate)).toEqual([mine.flagId, sibling.flagId]);
    });

    it('getRefusalLog never returns a downgrade row from another account', async () => {
      const mine = await seedDowngrade({
        action: AUDIT_ACTION_AUTO_POLICY_REVOKED_JUDGE_UNAVAILABLE,
        createdAt: new Date(NOW.getTime() - DAY_MS),
      });
      const foreign = await seedDowngrade({
        business: foreignBusinessId,
        accountId: otherTenant!.accountId,
        action: AUDIT_ACTION_AUTO_POLICY_REVOKED_JUDGE_UNAVAILABLE,
        createdAt: new Date(NOW.getTime() - 2 * DAY_MS),
      });

      const log = await getRefusalLog(sql(), accountScope(), '30d');
      expect(entryIds(log)).toEqual([mine.auditId]);

      const theirs = await getRefusalLog(
        sql(),
        { kind: 'account', accountId: otherTenant!.accountId },
        '30d',
      );
      expect(entryIds(theirs)).toEqual([foreign.auditId]);
    });

    it('getRefusalLog never returns a withheld ask from another location', async () => {
      const mine = await seedWithheldAsk({
        reason: 'no_consent',
        decidedAt: new Date(NOW.getTime() - DAY_MS),
      });
      const sibling = await seedWithheldAsk({
        business: siblingBusinessId,
        reason: 'suppressed',
        decidedAt: new Date(NOW.getTime() - 2 * DAY_MS),
      });

      const scoped = await getRefusalLog(sql(), locationScope(), '30d');
      expect(entryIds(scoped)).toEqual([mine]);

      // The sibling row really exists — the location scope excluded it, rather
      // than the fixture never having written it.
      const aggregate = await getRefusalLog(sql(), accountScope(), '30d');
      expect(entryIds(aggregate)).toEqual([mine, sibling]);
    });

    it.todo('getRefusalLog never returns a withheld outreach from another location');

    it.todo('getRefusalLog never returns a halted batch from another location');

    // Both tables carry independent FKs (flagged_responses at 051:15), not
    // tenant-composite keys, so a scoped ROOT row can still reach a foreign
    // review/response through an unscoped JOIN. The predicate is repeated on the
    // join, not only on the root.
    it('getRefusalLog does not expose a foreign review through a cross-tenant flagged-response join', async () => {
      const foreignReviewId = await seedReview(foreignBusinessId);
      // Root row is PERFECTLY scoped — our account, our location — and still
      // names a review under the other tenant. Only the join predicate can
      // catch this; the WHERE clause never sees it.
      const drifted = await seedHeldDraft({
        flaggedReviewId: foreignReviewId,
        createdAt: new Date(NOW.getTime() - DAY_MS),
      });
      const clean = await seedHeldDraft({ createdAt: new Date(NOW.getTime() - 2 * DAY_MS) });

      const log = await getRefusalLog(sql(), locationScope(), '30d');

      // The drifted row is dropped whole: no entry, and therefore no id the
      // Restraint tab could resolve into a foreign review link.
      expect(entryIds(log)).toEqual([clean.flagId]);
      expect(JSON.stringify(log)).not.toContain(foreignReviewId);
      expect(JSON.stringify(log)).not.toContain(drifted.flagId);
    });

    it('getRefusalLog does not expose a foreign response through a cross-tenant approval-audit join', async () => {
      const foreignReviewId = await seedReview(foreignBusinessId);
      const foreignResponseId = await seedDraftResponse(foreignBusinessId, foreignReviewId);
      const drifted = await seedDowngrade({
        responseId: foreignResponseId,
        action: AUDIT_ACTION_AUTO_POLICY_REVOKED_JUDGE_UNAVAILABLE,
        createdAt: new Date(NOW.getTime() - DAY_MS),
      });
      const clean = await seedDowngrade({
        action: AUDIT_ACTION_AUTO_POLICY_REVOKED_JUDGE_UNAVAILABLE,
        createdAt: new Date(NOW.getTime() - 2 * DAY_MS),
      });

      const log = await getRefusalLog(sql(), locationScope(), '30d');

      expect(entryIds(log)).toEqual([clean.auditId]);
      expect(JSON.stringify(log)).not.toContain(foreignReviewId);
      expect(JSON.stringify(log)).not.toContain(drifted.auditId);
    });
  });

  describe('getRefusalLog account-wide sources', () => {
    // S4 is `account_audit_log`, which has no location key: a suspension applies
    // to every location, so it appears in every location scope. Join nothing to
    // `businesses` here — an account-wide arm joined through locations multiplies
    // one audit row by the location count.
    it.todo('getRefusalLog includes an account-wide autonomy suspension in location scope');

    it.todo("getRefusalLog excludes another account's autonomy suspension in location scope");

    it.todo('getRefusalLog counts one autonomy suspension exactly once in aggregate scope');

    it.todo('getRefusalLog counts one autonomy suspension exactly once in location scope');
  });

  describe('getRefusalLog source presence', () => {
    it('getRefusalLog includes a held draft as unsafe_content', async () => {
      const createdAt = new Date(NOW.getTime() - 3 * DAY_MS);
      const held = await seedHeldDraft({ createdAt });

      const log = await getRefusalLog(sql(), locationScope(), '30d');

      expect(log).toEqual({
        total: 1,
        categories: [
          {
            // S1 has no code axis: the lane IS the fact, so the category is the
            // fixed HELD_DRAFT_REFUSAL_CATEGORY rather than a lookup.
            category: 'unsafe_content',
            count: 1,
            entries: [
              {
                id: held.flagId,
                source: 'held_draft',
                category: 'unsafe_content',
                occurredAt: createdAt.toISOString(),
                // S1 names the review the draft answers — the one link target
                // the locked table gives this category.
                reviewId: held.reviewId,
              },
            ],
          },
        ],
      });
    });

    // Redaction is the whole security story for S1 (plan §7 risk 1). This is the
    // read-layer half: the seeded moderation prose, draft body and review body
    // are REAL values, so the assertion is that none of them survives the read.
    // The three ROUTE cases (serialization, error path, logs) are T5's.
    it('getRefusalLog returns no draft text or review text for a held draft', async () => {
      await seedHeldDraft({ createdAt: new Date(NOW.getTime() - DAY_MS) });

      const log = await getRefusalLog(sql(), locationScope(), '30d');
      const serialized = JSON.stringify(log);

      expect(serialized).not.toContain(FLAG_REASON);
      expect(serialized).not.toContain(DRAFT_TEXT);
      expect(serialized).not.toContain(REVIEW_TEXT);

      // Positive half: the entry carries EXACTLY the five safe fields, so a
      // later widening shows up here instead of hiding behind three `not`s.
      const entries = allEntries(log);
      expect(entries).toHaveLength(1);
      expect(Object.keys(entries[0]!).sort()).toEqual([
        'category',
        'id',
        'occurredAt',
        'reviewId',
        'source',
      ]);
    });

    it('getRefusalLog includes an auto-policy downgrade with its mapped category', async () => {
      const createdAt = new Date(NOW.getTime() - 3 * DAY_MS);
      const revoked = await seedDowngrade({
        // Stored as ONE action for both judge reasons — the collapse the
        // action-keyed derivation exists to survive.
        action: AUDIT_ACTION_AUTO_POLICY_REVOKED_JUDGE_UNAVAILABLE,
        createdAt,
      });

      const log = await getRefusalLog(sql(), locationScope(), '30d');

      expect(log).toEqual({
        total: 1,
        categories: [
          {
            category: 'watchdog_unavailable',
            count: 1,
            entries: [
              {
                id: revoked.auditId,
                source: 'auto_post_revoked',
                category: 'watchdog_unavailable',
                occurredAt: createdAt.toISOString(),
                reviewId: revoked.reviewId,
              },
            ],
          },
        ],
      });
    });

    it.todo('getRefusalLog includes an autonomy suspension as autonomy_paused');

    it('getRefusalLog includes a withheld ask with its mapped category', async () => {
      const decidedAt = new Date(NOW.getTime() - 3 * DAY_MS);
      const askId = await seedWithheldAsk({ reason: 'no_consent', decidedAt });

      const log = await getRefusalLog(sql(), locationScope(), '30d');

      expect(log).toEqual({
        total: 1,
        categories: [
          {
            // `no_consent` maps to no_permission in ASK_WITHHELD_REFUSAL_CATEGORIES.
            category: 'no_permission',
            count: 1,
            entries: [
              {
                id: askId,
                source: 'ask_withheld',
                category: 'no_permission',
                occurredAt: decidedAt.toISOString(),
                // S5 names no review: the ask lane is about a contact, not a reply.
                reviewId: null,
              },
            ],
          },
        ],
      });
    });

    it.todo('getRefusalLog includes a withheld outreach with its mapped category');

    it.todo('getRefusalLog includes an admin_halt batch as autonomy_paused');

    it.todo('getRefusalLog includes a platform_halt batch as autonomy_paused');

    // Two acts of restraint on one draft are two refusals. Deduping to "one
    // response" would under-report exactly the repeat behaviour the tab exists
    // to make visible.
    it('getRefusalLog returns two entries when one response is downgraded twice', async () => {
      const reviewId = await seedReview(businessId);
      const responseId = await seedDraftResponse(businessId, reviewId);
      const older = await seedDowngrade({
        responseId,
        reviewId,
        action: AUDIT_ACTION_AUTO_POLICY_REVOKED_JUDGE_UNAVAILABLE,
        createdAt: new Date(NOW.getTime() - 3 * DAY_MS),
      });
      const newer = await seedDowngrade({
        responseId,
        reviewId,
        action: AUDIT_ACTION_AUTO_POLICY_REVOKED_JUDGE_UNAVAILABLE,
        createdAt: new Date(NOW.getTime() - DAY_MS),
      });

      const log = await getRefusalLog(sql(), locationScope(), '30d');

      // Same lane, same action, same response — and still two rows, newest
      // first. Nothing keys on the response, so nothing can collapse them.
      expect(log.total).toBe(2);
      expect(entryIds(log)).toEqual([newer.auditId, older.auditId]);
      expect(allEntries(log).map((entry) => entry.reviewId)).toEqual([reviewId, reviewId]);
      expect(log.categories.map((group) => group.category)).toEqual(['watchdog_unavailable']);
    });

    // A downgrade under a DIFFERENT action still maps, so the arm reads the
    // whole five-action list rather than the one the fixtures above use.
    it('getRefusalLog maps a policy-suspended downgrade to autonomy_paused', async () => {
      const revoked = await seedDowngrade({
        action: AUDIT_ACTION_AUTO_POLICY_REVOKED_POLICY_SUSPENDED,
        createdAt: new Date(NOW.getTime() - DAY_MS),
      });

      const log = await getRefusalLog(sql(), locationScope(), '30d');

      expect(log.categories.map((group) => group.category)).toEqual(['autonomy_paused']);
      expect(entryIds(log)).toEqual([revoked.auditId]);
    });

    // `unsuspendAccountAutonomy` clears both policy columns (suspension.ts:352-354),
    // so the durable trace is the audit row and a lifted suspension still appears.
    it.todo('getRefusalLog includes a suspension after the policy is later unsuspended');

    // INNER JOIN, not LEFT: an entry whose review cannot be resolved would
    // render a link to nothing. Note the schema makes this doubly enforced —
    // `flagged_responses.review_id` is `ON DELETE CASCADE` (051:18), so a
    // deleted review takes the flag row with it and a truly DANGLING review_id
    // is unrepresentable. The join is the second lock, and the observable
    // behaviour asserted here is the one the owner sees either way.
    it('getRefusalLog drops a flagged response whose review row is gone', async () => {
      const doomed = await seedHeldDraft({ createdAt: new Date(NOW.getTime() - DAY_MS) });
      const kept = await seedHeldDraft({ createdAt: new Date(NOW.getTime() - 2 * DAY_MS) });

      const before = await getRefusalLog(sql(), locationScope(), '30d');
      expect(entryIds(before)).toEqual([doomed.flagId, kept.flagId]);

      await sql()`DELETE FROM reviews WHERE id = ${doomed.reviewId}::uuid`;

      const after = await getRefusalLog(sql(), locationScope(), '30d');
      expect(entryIds(after)).toEqual([kept.flagId]);
    });

    it('getRefusalLog returns an empty result for an account with no refusals', async () => {
      // A real, seeded account that simply refused nothing — not a bare unknown id.
      const log = await getRefusalLog(
        sql(),
        { kind: 'account', accountId: otherTenant!.accountId },
        '30d',
      );

      expect(log).toEqual({ total: 0, categories: [] });
    });

    it('getRefusalLog orders entries newest first', async () => {
      const oldest = await seedWithheldAsk({
        reason: 'no_consent',
        decidedAt: new Date(NOW.getTime() - 3 * DAY_MS),
      });
      const newest = await seedWithheldAsk({
        reason: 'no_consent',
        decidedAt: new Date(NOW.getTime() - 1 * DAY_MS),
      });
      const middle = await seedWithheldAsk({
        reason: 'suppressed',
        decidedAt: new Date(NOW.getTime() - 2 * DAY_MS),
      });

      const log = await getRefusalLog(sql(), locationScope(), '30d');

      // All three map to no_permission, so one group carries the whole order —
      // the sort is on the statement, not a by-product of the grouping.
      expect(entryIds(log)).toEqual([newest, middle, oldest]);
    });
  });

  describe('getRefusalLog S6 timestamp anchor', () => {
    // THE WITHHELD ARM HAS TWO WRITERS, so the anchor is reason-dependent (plan §2
    // as corrected by review round 3; deviations D7). `dispatch.ts` `commitWithhold`
    // (1371-1379) writes five reasons and sets `agent_run_id` in the same statement,
    // and `agent_runs.started_at` (071:25) is DEFAULT NOW() with no updater — so the
    // lazy child run start IS the refusal time, durably. `ask-generation.ts` INSERTs
    // the other three (`moderation_high`, `render_failed`, `lint_failed`) ALREADY
    // withheld, and for those `rendered_at` IS the refusal time and is never updated.
    // Neither anchor is correct alone: `rendered_at` predates a dispatch-time
    // refusal, and `run.started_at` is the batch parent's start, not a render-time
    // row's decision. `updated_at` is a general mutation timestamp a later write can
    // move, hence fallback only.
    it.todo('getRefusalLog anchors a dispatch-time outreach refusal on its lazy child run start');

    it.todo('getRefusalLog anchors a render-time outreach refusal on rendered_at');

    it.todo('getRefusalLog falls back to updated_at for a withheld outreach with no agent run');

    // Both durable anchors are immovable. The ONE accepted residual drift is a
    // dispatch-time withhold whose best-effort lazy-child attach left
    // `agent_run_id` NULL and therefore falls back to `updated_at`.
    it.todo('getRefusalLog does not move a render-time or run-anchored outreach entry when the row is mutated later');
  });

  describe('getRefusalLog window boundaries', () => {
    it('getRefusalLog includes an entry timestamped exactly at the window start', async () => {
      const askId = await seedWithheldAsk({
        reason: 'no_consent',
        decidedAt: windowStart(30),
      });

      const log = await getRefusalLog(sql(), locationScope(), '30d');

      // `>=` at the start, matching getAgentTeamSummary.
      expect(entryIds(log)).toEqual([askId]);
    });

    it('getRefusalLog excludes an entry before the window start', async () => {
      await seedWithheldAsk({
        reason: 'no_consent',
        decidedAt: new Date(windowStart(30).getTime() - 1),
      });

      const log = await getRefusalLog(sql(), locationScope(), '30d');

      expect(log).toEqual({ total: 0, categories: [] });
    });

    it('getRefusalLog excludes an entry after the window end', async () => {
      // The window is [now - windowDays, now]; a stamp beyond `now` is outside it.
      await seedWithheldAsk({
        reason: 'no_consent',
        decidedAt: new Date(NOW.getTime() + 60_000),
      });

      const log = await getRefusalLog(sql(), locationScope(), '30d');

      expect(log).toEqual({ total: 0, categories: [] });
    });
  });

  describe('getRefusalLog exclusions', () => {
    // S6 reads the WITHHELD arm only. The cancelled arm is out of scope entirely,
    // including its admin_halt/platform_halt copies — S7 already counts that halt
    // once at the batch.
    it.todo('getRefusalLog excludes the cancelled arm of solicitation_outreach entirely');

    it.todo('getRefusalLog excludes owner_veto, owner_halt, owner_excluded and owner_withdrawn');

    it.todo('getRefusalLog excludes send_failed, send_exhausted, batch_expired and send_window_elapsed');

    it.todo('getRefusalLog excludes superseded and send_indeterminate outreach outcomes');

    // BatchReport.tsx:27 already rules this volume shaping, not a refusal.
    it('getRefusalLog excludes velocity_banked', async () => {
      await seedWithheldAsk({
        reason: 'velocity_banked',
        decidedAt: new Date(NOW.getTime() - DAY_MS),
      });
      const kept = await seedWithheldAsk({
        reason: 'stale_visit',
        decidedAt: new Date(NOW.getTime() - 2 * DAY_MS),
      });

      const log = await getRefusalLog(sql(), locationScope(), '30d');

      // The banked candidate is expected back in the next batch, so nothing was
      // declined — the vocabulary maps it to `null` and the arm never selects it.
      expect(entryIds(log)).toEqual([kept]);
      expect(log.total).toBe(1);
    });
  });
});
