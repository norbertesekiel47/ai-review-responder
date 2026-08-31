// ── #1012: the `auto_post_revoked` Refusal write site, against live Postgres ──
//
// WHY THIS FILE EXISTS AT ALL — the justification `working-rules.md` § Anti-slop
// requires for a new file. No suite in `worker/jobs/publisher/__tests__/` runs
// `auto-policy-downgrade.ts` against real Postgres: the unit suite drives a
// mocked `sql`, and the two live-DB suites in this directory
// (`autopilot-entitlement-concurrency`, `edit-existing-reply`) own other
// modules. Four properties this slice promises are unreachable without a real
// database — `occurred_at` equal to `approval_audit_log.created_at` to the
// microsecond, a rollback that takes the decision with it, the partial unique
// index's first-write-wins behaviour, and a claimed outbox attempt un-completing
// when the ledger fails. The `*.integration.test.ts` name is what selects
// vitest's serialized `integration` project, and no DDL runs here.
//
// WHY THE VOCABULARY MODULE IS MOCKED — the precedent is
// `src/lib/auto-approval/__tests__/suspension.integration.test.ts`, and the
// reason is identical: the two failure cases must force a REAL rejection from
// the REAL helper inside the REAL deciding transaction. A mocked-away
// `writeRefusalEvent` would prove only that a stub can reject. Bending ONE map
// entry to a category migration 116's CHECK does not admit produces exactly the
// writer bug the design says must abort the decision rather than be caught.
// The stand-in map is DERIVED from the real one inside the factory, never
// re-typed, so every other case runs against the production vocabulary.

import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import type postgresType from 'postgres';
import { v7 as uuidv7 } from 'uuid';
import { describeWithDb } from '@/__tests__/helpers/describe-with-db';
import {
  cleanupTenantAccount,
  seedTenantAccount,
  type TenantSeed,
} from '@/lib/shared/__tests__/live-db-tenant';
import { QUEUE_NAMES } from '@/lib/shared/queue-names';
import {
  AUDIT_ACTION_AUTO_POLICY_REVOKED_JUDGE_UNAVAILABLE,
  AUDIT_ACTION_AUTO_POLICY_REVOKED_POLICY_SUSPENDED,
} from '@/lib/approval/audit';
import type { AutoPolicyDowngradeReason } from '@/lib/shared/worker-types';
import {
  downgradeAutoApprovedResponseForManualReview,
  downgradeAutoApprovedResponseForManualReviewInTx,
} from '../auto-policy-downgrade';

const { autoPostRevokedCategories } = vi.hoisted(() => ({
  autoPostRevokedCategories: {} as Record<string, string>,
}));

vi.mock('@/lib/refusals/vocabulary', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/refusals/vocabulary')>();
  Object.assign(autoPostRevokedCategories, actual.AUTO_POST_REVOKED_REFUSAL_CATEGORIES);
  return { ...actual, AUTO_POST_REVOKED_REFUSAL_CATEGORIES: autoPostRevokedCategories };
});

/** The default-ON kill switch. Only the literal string 'false' disables it. */
const LEDGER_FLAG = 'REFUSAL_LEDGER_ENABLED';

/** Postgres' CHECK-violation SQLSTATE. */
const CHECK_VIOLATION = '23514';

const testDatabaseUrl = process.env.TEST_DATABASE_POOL_URL;

let db: postgresType.Sql | undefined;
let tenant: TenantSeed | undefined;
const businessId = randomUUID();
const logger = { warn: () => {} };

function sql(): postgresType.Sql {
  if (!db) throw new Error('auto-policy-downgrade integration database was not initialized');
  return db;
}

function requireTenant(): TenantSeed {
  if (!tenant) throw new Error('auto-policy-downgrade integration tenant was not seeded');
  return tenant;
}

// Local-host refusal guard: any localhost/127.0.0.1 Postgres is accepted (the
// dev container AND the CI service container), everything else — notably any
// Supabase/pooler host — is refused. Never widen this to remote hosts.
function assertExactLocalDatabaseUrl(databaseUrl: string | undefined): string {
  let parsed: URL | undefined;
  try {
    parsed = databaseUrl === undefined ? undefined : new URL(databaseUrl);
  } catch {
    parsed = undefined;
  }
  const isLocalPostgres =
    parsed !== undefined &&
    (parsed.protocol === 'postgres:' || parsed.protocol === 'postgresql:') &&
    (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1');
  if (databaseUrl === undefined || !isLocalPostgres) {
    throw new Error('auto-policy-downgrade integration requires a local (localhost) test database');
  }
  return databaseUrl;
}

interface SeededResponse {
  reviewId: string;
  responseId: string;
}

/**
 * One review + one auto-approved response under the fixture's business.
 *
 * A review PER response, because `responses_one_non_terminal_per_review` is a
 * partial unique index over the non-terminal statuses — two auto-approved
 * responses sharing a review is not a representable state.
 */
async function seedAutoApprovedResponse(overrides: {
  status?: string;
  approvalMethod?: string | null;
} = {}): Promise<SeededResponse> {
  const reviewId = randomUUID();
  const responseId = randomUUID();
  await sql()`
    INSERT INTO reviews (
      id, business_id, provider, provider_review_id, provider_review_name,
      provider_location_name, reviewer_name, star_rating, review_text, status
    ) VALUES (
      ${reviewId}::uuid, ${businessId}::uuid, 'zernio', ${`downgrade-int-${reviewId}`},
      ${`zernio://downgrade-int/reviews/${reviewId}`}, 'zernio://downgrade-int/locations/1',
      'Reviewer', 5, 'Wonderful service', 'responded'
    )
  `;
  await sql()`
    INSERT INTO responses (
      id, review_id, business_id, response_text, original_draft_text, response_language,
      status, approval_method, approved_at, approved_text
    ) VALUES (
      ${responseId}::uuid, ${reviewId}::uuid, ${businessId}::uuid,
      'Thanks for visiting!', 'Thanks for visiting!', 'en',
      ${overrides.status ?? 'approved'},
      ${overrides.approvalMethod === undefined ? 'auto_policy' : overrides.approvalMethod},
      NOW() - INTERVAL '20 minutes', 'Thanks for visiting!'
    )
  `;
  return { reviewId, responseId };
}

/** The dispatched publish attempt the downgrade claims before it decides. */
async function seedDispatchedPublishRow(responseId: string, attempts = 1): Promise<string> {
  const outboxId = uuidv7();
  await sql()`
    INSERT INTO job_outbox (
      id, topic, aggregate_type, aggregate_id, payload, status, attempts, dispatched_at
    ) VALUES (
      ${outboxId}, ${QUEUE_NAMES.PUBLISH_RESPONSE}, 'response', ${responseId},
      ${sql().json({ response_id: responseId, business_id: businessId })},
      'dispatched', ${attempts}, NOW()
    )
  `;
  return outboxId;
}

/**
 * Puts an already-downgraded response back into the auto-approved state with a
 * fresh dispatched attempt.
 *
 * The duplicate cases need the WRITE SITE to run twice for one response, and a
 * plain second call cannot do it: the response is `pending_approval` by then and
 * exits at the non-downgradeable guard, never reaching the ledger. Only a reset
 * puts the second write in front of the partial unique index, which is the
 * behaviour those two cases exist to pin.
 */
async function reArmForSecondDowngrade(responseId: string): Promise<string> {
  await sql()`
    UPDATE job_outbox SET status = 'completed', completed_at = NOW()
    WHERE aggregate_id = ${responseId}
      AND topic = ${QUEUE_NAMES.PUBLISH_RESPONSE}
      AND status IN ('pending', 'dispatching', 'dispatched')
  `;
  await sql()`
    UPDATE responses
    SET status = 'approved',
        approval_method = 'auto_policy',
        approved_at = NOW() - INTERVAL '20 minutes',
        approved_text = 'Thanks for visiting!',
        posting_error = NULL
    WHERE id = ${responseId}::uuid
  `;
  return seedDispatchedPublishRow(responseId);
}

interface RefusalRow {
  account_id: string;
  business_id: string | null;
  refusal_source: string;
  refusal_code: string | null;
  all_refusal_codes: string[] | null;
  refusal_category: string;
  subject_type: string | null;
  subject_id: string | null;
  /**
   * Read as `::text`. postgres.js decodes timestamptz to a JS `Date` and
   * TRUNCATES microseconds (#520) — and the microseconds are the entire content
   * of the `occurred_at` / `approval_audit_log.created_at` equality below.
   */
  occurred_at: string;
}

async function readRefusalRows(): Promise<RefusalRow[]> {
  return sql()<RefusalRow[]>`
    SELECT account_id::text AS account_id,
           business_id::text AS business_id,
           refusal_source,
           refusal_code,
           all_refusal_codes,
           refusal_category,
           subject_type,
           subject_id::text AS subject_id,
           occurred_at::text AS occurred_at
    FROM refusal_events
    WHERE account_id = ${requireTenant().accountId}::uuid
    ORDER BY occurred_at, subject_id
  `;
}

interface ResponseRow {
  status: string;
  approval_method: string | null;
  posting_error: string | null;
}

async function readResponse(responseId: string): Promise<ResponseRow> {
  const [row] = await sql()<ResponseRow[]>`
    SELECT status, approval_method, posting_error FROM responses WHERE id = ${responseId}::uuid
  `;
  if (!row) throw new Error(`expected response ${responseId}`);
  return row;
}

/** The three durable facts the downgrade writes beside the Refusal. */
async function readDowngradeFactCounts(responseId: string): Promise<{
  audit_count: number;
  notification_count: number;
}> {
  const [facts] = await sql()<{ audit_count: number; notification_count: number }[]>`
    SELECT
      (SELECT COUNT(*)::int FROM approval_audit_log
       WHERE response_id = ${responseId}::uuid) AS audit_count,
      (SELECT COUNT(*)::int FROM job_outbox
       WHERE topic = ${QUEUE_NAMES.SEND_NOTIFICATION}
         AND aggregate_id = ${responseId}) AS notification_count
  `;
  if (!facts) throw new Error('expected downgrade fact counts');
  return facts;
}

async function readOutboxRow(outboxId: string): Promise<{ status: string; attempts: number }> {
  const [row] = await sql()<{ status: string; attempts: number }[]>`
    SELECT status, attempts FROM job_outbox WHERE id = ${outboxId}
  `;
  if (!row) throw new Error(`expected outbox row ${outboxId}`);
  return row;
}

function downgradeInput(responseId: string, outboxId: string, options: {
  reason?: AutoPolicyDowngradeReason;
  outboxAttempt?: number;
  businessId?: string;
} = {}) {
  return {
    responseId,
    businessId: options.businessId ?? businessId,
    outboxId,
    outboxAttempt: options.outboxAttempt ?? 1,
    correlationId: 'downgrade-int-corr',
    reason: options.reason ?? ('judge_disabled' as const),
    logger,
  };
}

async function cleanDomainRows(): Promise<void> {
  const accountId = requireTenant().accountId;
  await sql()`DELETE FROM refusal_events WHERE account_id = ${accountId}::uuid`;
  await sql()`DELETE FROM approval_audit_log WHERE business_id = ${businessId}::uuid`;
  await sql()`
    DELETE FROM job_outbox
    WHERE aggregate_id IN (SELECT id FROM responses WHERE business_id = ${businessId}::uuid)
  `;
  await sql()`DELETE FROM responses WHERE business_id = ${businessId}::uuid`;
  await sql()`DELETE FROM reviews WHERE business_id = ${businessId}::uuid`;
}

describeWithDb('auto-policy downgrade Refusal against live local Postgres', { timeout: 40_000 }, () => {
  beforeAll(async () => {
    db = postgres(assertExactLocalDatabaseUrl(testDatabaseUrl), { max: 2, prepare: false });
    tenant = await seedTenantAccount(db, {
      userName: 'Downgrade Integration Owner',
      accountDisplayName: 'Downgrade Integration Account',
    });
    await db`
      INSERT INTO businesses (id, name, owner_name, owner_email, account_id, subscription_status, is_primary)
      VALUES (
        ${businessId}::uuid, 'Downgrade Integration Biz', 'Owner', ${tenant.ownerEmail},
        ${tenant.accountId}::uuid, 'active', TRUE
      )
    `;
  });

  beforeEach(async () => {
    // The ledger is default-ON. A 'false' leaked from the kill-switch case
    // would turn every other Refusal assertion into a silently-passing no-op.
    delete process.env[LEDGER_FLAG];
    await cleanDomainRows();
  });

  afterEach(() => {
    delete process.env[LEDGER_FLAG];
  });

  afterAll(async () => {
    if (!db || !tenant) return;
    await cleanDomainRows();
    await sql()`DELETE FROM businesses WHERE id = ${businessId}::uuid`;
    await cleanupTenantAccount(sql(), tenant);
    await db.end({ timeout: 5 });
  });

  it('a downgrade writes exactly one refusal_events row against the response id', async () => {
    const { responseId } = await seedAutoApprovedResponse();
    const outboxId = await seedDispatchedPublishRow(responseId);

    await expect(
      downgradeAutoApprovedResponseForManualReview(sql(), downgradeInput(responseId, outboxId)),
    ).resolves.toBe('downgraded');

    const rows = await readRefusalRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      account_id: requireTenant().accountId,
      // C3 — this lane names the location it happened at.
      business_id: businessId,
      refusal_source: 'auto_post_revoked',
      refusal_code: 'judge_disabled',
      refusal_category: 'watchdog_unavailable',
      subject_type: 'response',
      subject_id: responseId,
      // C5 — no code array outside `policy_gate_held`.
      all_refusal_codes: null,
    });
    // The decision itself really did land, so the single row is not one written
    // beside a downgrade that never happened.
    expect(await readResponse(responseId)).toMatchObject({
      status: 'pending_approval',
      approval_method: null,
      posting_error: AUDIT_ACTION_AUTO_POLICY_REVOKED_JUDGE_UNAVAILABLE,
    });
  });

  it("a downgrade's refusal_events row carries subject_type response, never the approval audit row id", async () => {
    const { responseId } = await seedAutoApprovedResponse();
    const outboxId = await seedDispatchedPublishRow(responseId);

    await expect(
      downgradeAutoApprovedResponseForManualReview(sql(), downgradeInput(responseId, outboxId)),
    ).resolves.toBe('downgraded');

    // #1001 superseded #997 on exactly this point: the subject is the RESPONSE.
    // The audit row is written in the same transaction and has an id of its own,
    // so a writer that pointed at the audit row would still produce a
    // well-formed uuid subject that passes every count assertion.
    const [audit] = await sql()<{ id: string }[]>`
      SELECT id::text AS id FROM approval_audit_log WHERE response_id = ${responseId}::uuid
    `;
    expect(audit, 'expected one approval_audit_log row').toBeDefined();

    const [refusal] = await readRefusalRows();
    expect(refusal!.subject_type).toBe('response');
    expect(refusal!.subject_id).toBe(responseId);
    expect(refusal!.subject_id).not.toBe(audit!.id);
  });

  it("a downgrade's refusal_events row carries occurred_at equal to the approval_audit_log created_at written by the same transaction", async () => {
    const { responseId } = await seedAutoApprovedResponse();
    const outboxId = await seedDispatchedPublishRow(responseId);

    await expect(
      downgradeAutoApprovedResponseForManualReview(sql(), downgradeInput(responseId, outboxId)),
    ).resolves.toBe('downgraded');

    // Both columns read as ::text, and compared in SQL. `NOW()` is
    // `transaction_timestamp()` — transaction START, stable across every
    // statement — and `approval_audit_log.created_at` is `DEFAULT NOW()`, so two
    // rows written in one transaction agree to the microsecond. A site that read
    // the clock back as a JS `Date` and passed it in would lose those
    // microseconds (#520) and the equality with it.
    const [pair] = await sql()<{
      refusal_occurred_at: string;
      audit_created_at: string;
    }[]>`
      SELECT refusal.occurred_at::text AS refusal_occurred_at,
             audit.created_at::text AS audit_created_at
      FROM refusal_events refusal
      JOIN approval_audit_log audit
        ON audit.response_id = refusal.subject_id
      WHERE refusal.account_id = ${requireTenant().accountId}::uuid
    `;

    expect(pair, 'expected one refusal row joined to one audit row').toBeDefined();
    expect(pair!.refusal_occurred_at).toBe(pair!.audit_created_at);
    // Microseconds are actually PRESENT, so the equality is not two truncated
    // values agreeing by accident.
    expect(pair!.refusal_occurred_at).toMatch(/\.\d{1,6}/);
  });

  it('a downgrade records the AutoPolicyDowngradeReason verbatim, so judge_disabled and judge_unhealthy stay two codes', async () => {
    const disabled = await seedAutoApprovedResponse();
    const disabledOutbox = await seedDispatchedPublishRow(disabled.responseId);
    const unhealthy = await seedAutoApprovedResponse();
    const unhealthyOutbox = await seedDispatchedPublishRow(unhealthy.responseId);

    await expect(downgradeAutoApprovedResponseForManualReview(
      sql(),
      downgradeInput(disabled.responseId, disabledOutbox, { reason: 'judge_disabled' }),
    )).resolves.toBe('downgraded');
    await expect(downgradeAutoApprovedResponseForManualReview(
      sql(),
      downgradeInput(unhealthy.responseId, unhealthyOutbox, { reason: 'judge_unhealthy' }),
    )).resolves.toBe('downgraded');

    const bySubject = new Map((await readRefusalRows()).map((row) => [row.subject_id, row]));
    expect(bySubject.size).toBe(2);
    // ONE audit marker and ONE category between them, yet TWO codes. The
    // downgrade collapses the pair at `DOWNGRADE_MARKERS`
    // (`auto_policy_revoked_judge_unavailable` for both) and the vocabulary
    // collapses it again at `watchdog_unavailable` — the verbatim
    // `refusal_code` is the only place the distinction survives.
    expect(bySubject.get(disabled.responseId)).toMatchObject({
      refusal_code: 'judge_disabled',
      refusal_category: 'watchdog_unavailable',
    });
    expect(bySubject.get(unhealthy.responseId)).toMatchObject({
      refusal_code: 'judge_unhealthy',
      refusal_category: 'watchdog_unavailable',
    });
    const [disabledRow, unhealthyRow] = [
      await readResponse(disabled.responseId),
      await readResponse(unhealthy.responseId),
    ];
    expect(disabledRow.posting_error).toBe(unhealthyRow.posting_error);
  });

  // ── the no-op exits: a Refusal records a DECISION ─────────────────────────

  it('a no-op downgrade on a response that is not downgradeable writes no refusal_events row', async () => {
    const { responseId } = await seedAutoApprovedResponse({
      status: 'pending_approval',
      approvalMethod: null,
    });
    const outboxId = await seedDispatchedPublishRow(responseId);

    await expect(
      downgradeAutoApprovedResponseForManualReview(sql(), downgradeInput(responseId, outboxId)),
    ).resolves.toBe('no-op');

    expect(await readRefusalRows()).toEqual([]);
    await expect(readDowngradeFactCounts(responseId)).resolves.toEqual({
      audit_count: 0,
      notification_count: 0,
    });
  });

  it('a downgrade that loses the outbox attempt CAS writes no refusal_events row', async () => {
    const { responseId } = await seedAutoApprovedResponse();
    // The row is on attempt 1; this caller is a stale worker resolving for
    // attempt 2, so the guarded CAS matches nothing and the function exits
    // BEFORE the response mutation and the ledger.
    const outboxId = await seedDispatchedPublishRow(responseId, 1);

    await expect(downgradeAutoApprovedResponseForManualReview(
      sql(),
      downgradeInput(responseId, outboxId, { outboxAttempt: 2 }),
    )).resolves.toBe('no-op');

    expect(await readRefusalRows()).toEqual([]);
    expect(await readResponse(responseId)).toMatchObject({
      status: 'approved',
      approval_method: 'auto_policy',
    });
    expect(await readOutboxRow(outboxId)).toMatchObject({ status: 'dispatched' });
  });

  it('a no-op downgrade with no review anchor writes no refusal_events row', async () => {
    // `anchorReviewLockOrder` is the FIRST exit — before the business lock,
    // before the response lock, before the CAS. An implementation that wrote the
    // Refusal above it would still pass every other no-op case in this suite.
    const { responseId } = await seedAutoApprovedResponse();
    const outboxId = await seedDispatchedPublishRow(responseId);
    const unknownResponseId = randomUUID();

    await expect(downgradeAutoApprovedResponseForManualReview(
      sql(),
      downgradeInput(unknownResponseId, outboxId),
    )).resolves.toBe('no-op');

    expect(await readRefusalRows()).toEqual([]);
    // The real response is untouched, so the no-op is the anchor's doing and
    // not a downgrade that silently addressed the wrong row.
    expect(await readResponse(responseId)).toMatchObject({
      status: 'approved',
      approval_method: 'auto_policy',
    });
  });

  // ── duplicates: the partial unique index, first-write-wins ────────────────

  it('downgrading the same response twice leaves one refusal_events row and lets the second transaction commit', async () => {
    const { responseId } = await seedAutoApprovedResponse();
    const firstOutbox = await seedDispatchedPublishRow(responseId);

    await expect(downgradeAutoApprovedResponseForManualReview(
      sql(),
      downgradeInput(responseId, firstOutbox),
    )).resolves.toBe('downgraded');

    const secondOutbox = await reArmForSecondDowngrade(responseId);
    // The SECOND transaction must COMMIT. `refusal_events_subject_uniq` is a
    // plain unique index, so without the helper's `ON CONFLICT … DO NOTHING`
    // this raises 23505 and takes the whole downgrade with it — the ledger
    // breaking the decision it exists to record.
    await expect(downgradeAutoApprovedResponseForManualReview(
      sql(),
      downgradeInput(responseId, secondOutbox),
    )).resolves.toBe('downgraded');

    expect(await readRefusalRows()).toHaveLength(1);
    // Two audit rows prove the second transaction committed rather than being
    // swallowed by an earlier guard.
    await expect(readDowngradeFactCounts(responseId)).resolves.toEqual({
      audit_count: 2,
      notification_count: 2,
    });
  });

  it('downgrading the same response for two different reasons keeps the first refusal code and category', async () => {
    const { responseId } = await seedAutoApprovedResponse();
    const firstOutbox = await seedDispatchedPublishRow(responseId);

    await expect(downgradeAutoApprovedResponseForManualReview(
      sql(),
      downgradeInput(responseId, firstOutbox, { reason: 'judge_disabled' }),
    )).resolves.toBe('downgraded');

    const secondOutbox = await reArmForSecondDowngrade(responseId);
    await expect(downgradeAutoApprovedResponseForManualReview(
      sql(),
      downgradeInput(responseId, secondOutbox, { reason: 'policy_suspended' }),
    )).resolves.toBe('downgraded');

    // FIRST-WRITE-WINS, and it is a decided semantic rather than an accident:
    // the index is `(refusal_source, subject_id)`, the subject is the response,
    // and `DO NOTHING` means the first Refusal for a response stands. Two
    // DIFFERENT reasons are what make this discriminating — the same reason
    // twice cannot tell `DO NOTHING` from an UPDATE to the latest reason. The
    // two reasons also carry two DIFFERENT categories, so a row rewritten by a
    // future `DO UPDATE` fails on both columns.
    const rows = await readRefusalRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      refusal_code: 'judge_disabled',
      refusal_category: 'watchdog_unavailable',
    });
    // The response itself DID take the second reason's marker, so the row above
    // is stale by design and not evidence the second downgrade no-opped.
    expect(await readResponse(responseId)).toMatchObject({
      posting_error: AUDIT_ACTION_AUTO_POLICY_REVOKED_POLICY_SUSPENDED,
    });
  });

  // ── the caller's transaction: invariant #15 ───────────────────────────────

  it('the standalone wrapper and the in-transaction caller each write exactly one refusal_events row', async () => {
    const standalone = await seedAutoApprovedResponse();
    const standaloneOutbox = await seedDispatchedPublishRow(standalone.responseId);
    const inTx = await seedAutoApprovedResponse();
    const inTxOutbox = await seedDispatchedPublishRow(inTx.responseId);

    // The wrapper opens its own transaction; the entitlement lane passes one
    // already open. BOTH reach the same single write site, so neither arm can
    // drift from the other — a second write site would show up here as a
    // per-arm difference.
    await expect(downgradeAutoApprovedResponseForManualReview(
      sql(),
      downgradeInput(standalone.responseId, standaloneOutbox),
    )).resolves.toBe('downgraded');
    await expect(sql().begin((tx) => downgradeAutoApprovedResponseForManualReviewInTx(
      tx,
      downgradeInput(inTx.responseId, inTxOutbox),
    ))).resolves.toBe('downgraded');

    const rows = await readRefusalRows();
    expect(rows).toHaveLength(2);
    expect(rows.filter((row) => row.subject_id === standalone.responseId)).toHaveLength(1);
    expect(rows.filter((row) => row.subject_id === inTx.responseId)).toHaveLength(1);
  });

  it('the in-transaction downgrade writes the refusal on the caller transaction and an outer rollback removes it', async () => {
    // THE CASE THAT DISCRIMINATES INVARIANT #15, and the sharpest finding of the
    // plan's round 1. A write site that opened a SECOND transaction for the
    // ledger passes every count assertion in this file: the row exists, there is
    // exactly one of it, and its subject is right. What it cannot do is die with
    // the decision. Here the write SUCCEEDS first and the caller then aborts for
    // a reason that has nothing to do with the ledger.
    //
    // BE EXACT ABOUT HOW A SECOND TRANSACTION DIES HERE — an earlier wording of
    // this comment was wrong and red team caught it by planting the mutation.
    // An independently committed row does NOT sit on disk at the last assertion.
    // The caller holds `businesses … FOR UPDATE`, and `refusal_events.business_id`
    // references that row, so an insert on its own connection needs `FOR KEY
    // SHARE` against a row this transaction has locked: it BLOCKS, and the case
    // fails on the statement timeout instead. The test goes RED either way,
    // which is what it is for — but the mechanism is a lock wait, not a ghost row.
    //
    // Nothing else catches this shape: `ci:db-imports` matches the
    // `@/lib/db/server` specifier only, so a bare `postgres(…)` is invisible to
    // it, and invariant #1's ESLint boundary does not cover `worker/`.
    const { responseId } = await seedAutoApprovedResponse();
    const outboxId = await seedDispatchedPublishRow(responseId);
    const abort = new Error('caller aborted after the ledger wrote — unrelated to the ledger');

    await expect(sql().begin(async (tx) => {
      await expect(downgradeAutoApprovedResponseForManualReviewInTx(
        tx,
        downgradeInput(responseId, outboxId),
      )).resolves.toBe('downgraded');

      // Read INSIDE the transaction, before aborting it. A write site that
      // silently wrote nothing would otherwise satisfy the zero-rows assertion
      // below by vacuum.
      const [written] = await tx<{ refusal_count: number }[]>`
        SELECT COUNT(*)::int AS refusal_count
        FROM refusal_events
        WHERE subject_id = ${responseId}::uuid
      `;
      expect(written?.refusal_count).toBe(1);

      throw abort;
    })).rejects.toBe(abort);

    // The row went down with the decision it recorded.
    expect(await readRefusalRows()).toEqual([]);
    // And the rollback really did reach everything else, so the zero above is
    // not a rollback that skipped the ledger.
    expect(await readResponse(responseId)).toMatchObject({
      status: 'approved',
      approval_method: 'auto_policy',
    });
    await expect(readDowngradeFactCounts(responseId)).resolves.toEqual({
      audit_count: 0,
      notification_count: 0,
    });
  });

  // ── failure and the kill switch ───────────────────────────────────────────

  it('a ledger failure rolls back the downgrade, the approval audit row and the notification enqueue together', async () => {
    const { responseId } = await seedAutoApprovedResponse();
    const outboxId = await seedDispatchedPublishRow(responseId);
    const original = { ...autoPostRevokedCategories };
    // A writer bug: a category `refusal_events_refusal_category_check` does not
    // admit. The helper does NOT catch it — `ON CONFLICT` covers duplicate keys
    // only — and it must abort the decision rather than be hidden in the one
    // place the ledger cannot report it. Forced through a REAL constraint, never
    // a mocked rejection: a mocked reject proves the call site propagates, not
    // that Postgres aborts the transaction.
    autoPostRevokedCategories.judge_disabled = 'a_category_the_ledger_never_named';
    try {
      await expect(downgradeAutoApprovedResponseForManualReview(
        sql(),
        downgradeInput(responseId, outboxId),
      )).rejects.toMatchObject({
        code: CHECK_VIOLATION,
        constraint_name: expect.stringContaining('refusal_events'),
      });
    } finally {
      for (const key of Object.keys(autoPostRevokedCategories)) {
        delete autoPostRevokedCategories[key];
      }
      Object.assign(autoPostRevokedCategories, original);
    }

    expect(await readResponse(responseId)).toMatchObject({
      status: 'approved',
      approval_method: 'auto_policy',
      posting_error: null,
    });
    await expect(readDowngradeFactCounts(responseId)).resolves.toEqual({
      audit_count: 0,
      notification_count: 0,
    });
    expect(await readRefusalRows()).toEqual([]);
  });

  it('a ledger failure rolls back completion of the claimed outbox attempt so the publisher can retry', async () => {
    const { responseId } = await seedAutoApprovedResponse();
    const outboxId = await seedDispatchedPublishRow(responseId);
    const original = { ...autoPostRevokedCategories };
    autoPostRevokedCategories.judge_disabled = 'a_category_the_ledger_never_named';
    try {
      await expect(downgradeAutoApprovedResponseForManualReview(
        sql(),
        downgradeInput(responseId, outboxId),
      )).rejects.toMatchObject({ code: CHECK_VIOLATION });
    } finally {
      for (const key of Object.keys(autoPostRevokedCategories)) {
        delete autoPostRevokedCategories[key];
      }
      Object.assign(autoPostRevokedCategories, original);
    }

    // `markOutboxCompletedIfOwned` claims the exact dispatched attempt BEFORE
    // the downgrade. If a ledger failure left that completion committed, the
    // publisher could never retry this response — the attempt would be
    // terminal with nothing to show for it.
    expect(await readOutboxRow(outboxId)).toEqual({ status: 'dispatched', attempts: 1 });

    // And the retry really does work once the writer bug is gone.
    await expect(downgradeAutoApprovedResponseForManualReview(
      sql(),
      downgradeInput(responseId, outboxId),
    )).resolves.toBe('downgraded');
    expect(await readOutboxRow(outboxId)).toMatchObject({ status: 'completed' });
    expect(await readRefusalRows()).toHaveLength(1);
  });

  it('REFUSAL_LEDGER_ENABLED=false changes only the refusal row and preserves the response downgrade, approval audit, notification enqueue, and outbox completion', async () => {
    process.env[LEDGER_FLAG] = 'false';
    const { responseId } = await seedAutoApprovedResponse();
    const outboxId = await seedDispatchedPublishRow(responseId);

    await expect(
      downgradeAutoApprovedResponseForManualReview(sql(), downgradeInput(responseId, outboxId)),
    ).resolves.toBe('downgraded');

    // The kill switch stops the LEDGER and nothing else — that is what makes it
    // a lever rather than a revert deploy. All four pre-existing effects are
    // asserted, not merely the return value.
    expect(await readResponse(responseId)).toMatchObject({
      status: 'pending_approval',
      approval_method: null,
      posting_error: AUDIT_ACTION_AUTO_POLICY_REVOKED_JUDGE_UNAVAILABLE,
    });
    await expect(readDowngradeFactCounts(responseId)).resolves.toEqual({
      audit_count: 1,
      notification_count: 1,
    });
    expect(await readOutboxRow(outboxId)).toMatchObject({ status: 'completed' });
    expect(await readRefusalRows()).toEqual([]);
  });
});
