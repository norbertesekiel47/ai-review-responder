import { randomUUID } from 'node:crypto';
import fc from 'fast-check';
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
} from '@/lib/shared/__tests__/helpers/schema-ready';
import {
  cleanupTenantAccount,
  seedLocation,
  seedTenantAccount,
  type TenantSeed,
} from '@/lib/shared/__tests__/live-db-tenant';
import { insertOutreach, seedContactCsvUpload } from '@/lib/shared/__tests__/helpers/outreach-fixture';
import { BATCH_HALTED_REFUSAL_CATEGORIES } from '@/lib/refusals/vocabulary';
import {
  adminHaltBatch,
  haltBatch,
  latchSystemHalt,
  type LatchSystemHaltResult,
  type SystemHaltReason,
} from '../approval';

// ─────────────────────────────────────────────────────────────────────────────
// The THIRD arm of the **Halt latch** — `latchSystemHalt` (#900 task 2).
//
// All three arms are imported normally now that the system one exists. The
// property case needs the two OWNER arms because it proves the latch is
// monotone ACROSS actor classes, not merely within the new one — and that is
// also the only way to reach `latchHalt`'s `halted_at IS NULL` CAS at all:
// both owner arms refuse at `state === 'halted'` first (#895(b)), so the system
// arm skipping that guard is what makes the CAS the sole defense.
//
// Applies NO migration SQL — `pnpm test:db:setup` provisions the schema and
// `assertSchemaReady` asserts it (#573). Holds the cross-process live-DB lock
// because the property case reseeds one batch many times and an unrelated
// writer would make its step and audit counts unreadable.
// ─────────────────────────────────────────────────────────────────────────────

const testDatabaseUrl = resolveTestDatabaseUrl();
const businessId = randomUUID();
/** The acting RepWorth operator: a GLOBAL `users` row with no account_id. */
const adminUserId = randomUUID();
const ADMIN_NOTE = 'Operator halted this batch while proving latch monotonicity.';

let db: postgresType.Sql | undefined;
let featureDatabaseLock: LiveDbLock | undefined;
let tenant: TenantSeed | undefined;

function sql(): postgresType.Sql {
  if (!db) throw new Error('system-halt integration database was not initialized');
  return db;
}

function accountId(): string {
  if (!tenant) throw new Error('system-halt integration tenant was not seeded');
  return tenant.accountId;
}

function userId(): string {
  if (!tenant) throw new Error('system-halt integration tenant was not seeded');
  return tenant.userId;
}

// ── fixtures ────────────────────────────────────────────────────────────────

async function seedUpload(): Promise<string> {
  return seedContactCsvUpload(sql(), {
    accountId: accountId(),
    businessId,
    attestedByUserId: userId(),
    filenamePrefix: 'system-halt',
    attestationVersion: 'system-halt-test',
  });
}

interface SeededBatch {
  batchId: string;
  uploadId: string;
}

/**
 * One approved, mid-drip batch. `created_at` is anchored 40 days back so the
 * built-after-created arm holds; every stamp is a SQL interval off NOW(),
 * because postgres.js truncates timestamptz microseconds on a JS round-trip.
 */
async function seedApprovedBatch(): Promise<SeededBatch> {
  const uploadId = await seedUpload();
  const batchId = randomUUID();
  await sql()`
    INSERT INTO solicitation_batches (
      id, account_id, business_id, source_upload_id, created_at,
      built_at, approved_at, approval_method, approved_by_user_id,
      veto_deadline_at, sending_started_at
    ) VALUES (
      ${batchId}::uuid, ${accountId()}::uuid, ${businessId}::uuid,
      ${uploadId}::uuid, NOW() - INTERVAL '40 days',
      NOW() - INTERVAL '3 hours', NOW() - INTERVAL '2 hours', 'owner',
      ${userId()}::uuid, NOW() - INTERVAL '105 minutes', NOW() - INTERVAL '90 minutes'
    )
  `;
  return { batchId, uploadId };
}

async function seedSendParent(batchId: string): Promise<string> {
  const runId = randomUUID();
  await sql()`
    INSERT INTO agent_runs (
      id, account_id, business_id, kind, subject_type, subject_id,
      status, started_at, correlation_id
    ) VALUES (
      ${runId}::uuid, ${accountId()}::uuid, ${businessId}::uuid,
      'solicitation_send_batch', 'solicitation_batch', ${batchId},
      'running', NOW() - INTERVAL '2 hours', 'system-halt-integration'
    )
  `;
  return runId;
}

async function seedAsk(batch: SeededBatch): Promise<{ askId: string; contactId: string }> {
  const contactId = randomUUID();
  await sql()`
    INSERT INTO solicitation_contacts (id, business_id, name, email, created_by_upload_id)
    VALUES (${contactId}::uuid, ${businessId}::uuid, 'System Halt Candidate',
            ${`${contactId}@example.test`}, ${batch.uploadId}::uuid)
  `;
  const askId = randomUUID();
  await sql()`
    INSERT INTO solicitation_asks (
      id, account_id, business_id, batch_id, contact_id, status,
      withheld_reason, evidence, decided_at
    ) VALUES (
      ${askId}::uuid, ${accountId()}::uuid, ${businessId}::uuid,
      ${batch.batchId}::uuid, ${contactId}::uuid, 'send', NULL,
      ${sql().json({ contact_id: contactId, policy_version: 'system-halt-fixture', decision: 'send' })},
      NOW()
    )
  `;
  return { askId, contactId };
}

/** One Outreach row on its OWN ask — 091's live-attempt index is per-ask. */
async function seedOutreach(
  batch: SeededBatch,
  deliveryStatus: 'rendered' | 'queued' | 'sending',
): Promise<string> {
  const { askId, contactId } = await seedAsk(batch);
  const dispatched = deliveryStatus === 'queued' || deliveryStatus === 'sending';
  return insertOutreach(sql(), {
    accountId: accountId(),
    businessId,
    batchId: batch.batchId,
    askId,
    contactId,
    deliveryStatus,
    queuedAt: dispatched ? sql()`NOW() - INTERVAL '10 minutes'` : null,
    sendingAt: deliveryStatus === 'sending' ? sql()`NOW() - INTERVAL '5 minutes'` : null,
    sentAt: null,
  });
}

// ── the caller's contract: the batch row lock is ALREADY held ───────────────

/**
 * `latchSystemHalt` does NOT call `lockBatchForAction` — there is no owner
 * request to authorize — so its docstring makes the LOCK the caller's
 * obligation. Every case here discharges it exactly as the release poller's
 * sweeps will: one transaction, the batch row locked first, then the latch.
 * Lock order stays batch → run throughout.
 */
async function latchUnderLock(
  batchId: string,
  reason: SystemHaltReason,
): Promise<LatchSystemHaltResult> {
  return sql().begin(async (tx) => {
    const locked = await tx<{ id: string }[]>`
      SELECT id FROM solicitation_batches
      WHERE id = ${batchId}::uuid
        AND account_id = ${accountId()}::uuid
        AND business_id = ${businessId}::uuid
      FOR UPDATE
    `;
    if (locked.count === 0) throw new Error(`batch ${batchId} vanished before the latch`);
    return latchSystemHalt(tx, {
      batchId,
      accountId: accountId(),
      businessId,
      reason,
    });
  }) as Promise<LatchSystemHaltResult>;
}

// ── readers ─────────────────────────────────────────────────────────────────

interface HaltRow {
  halted_at: Date | null;
  halt_reason: string | null;
  halted_by: string | null;
  send_closed_at: Date | null;
}

async function readHalt(batchId: string): Promise<HaltRow> {
  const [row] = await sql()<HaltRow[]>`
    SELECT halted_at, halt_reason, halted_by::text AS halted_by, send_closed_at
    FROM solicitation_batches
    WHERE id = ${batchId}::uuid AND account_id = ${accountId()}::uuid
  `;
  if (!row) throw new Error(`batch ${batchId} vanished`);
  return row;
}

async function readOutreachStatus(outreachId: string): Promise<{
  delivery_status: string;
  disposition_reason: string | null;
}> {
  const [row] = await sql()<{ delivery_status: string; disposition_reason: string | null }[]>`
    SELECT delivery_status, disposition_reason FROM solicitation_outreach
    WHERE id = ${outreachId}::uuid AND account_id = ${accountId()}::uuid
  `;
  if (!row) throw new Error(`outreach ${outreachId} vanished`);
  return row;
}

async function readHaltSteps(runId: string): Promise<{ detail: unknown }[]> {
  return sql()<{ detail: unknown }[]>`
    SELECT detail FROM agent_run_steps
    WHERE agent_run_id = ${runId}::uuid AND step_key = 'batch_halted'
    ORDER BY step_index
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

async function countAuditRows(): Promise<number> {
  const [row] = await sql()<{ count: number }[]>`
    SELECT COUNT(*)::int AS count FROM account_audit_log
    WHERE account_id = ${accountId()}::uuid
  `;
  return row?.count ?? 0;
}

/**
 * Every Refusal written against ONE batch (#1010). Read as `::text`: postgres.js
 * decodes `timestamptz` to a JS `Date` and truncates microseconds (#520), and
 * `occurred_at` here is the same `NOW()` the CAS wrote into `halted_at`.
 */
async function readRefusals(batchId: string): Promise<{
  refusal_source: string;
  refusal_code: string | null;
  refusal_category: string;
  subject_type: string | null;
  subject_id: string | null;
  account_id: string;
  business_id: string | null;
  matches_halted_at: boolean | null;
}[]> {
  return sql()`
    SELECT refusal.refusal_source,
           refusal.refusal_code,
           refusal.refusal_category,
           refusal.subject_type,
           refusal.subject_id::text AS subject_id,
           refusal.account_id::text AS account_id,
           refusal.business_id::text AS business_id,
           (refusal.occurred_at = batch.halted_at) AS matches_halted_at
    FROM refusal_events refusal
    LEFT JOIN solicitation_batches batch ON batch.id = refusal.subject_id
    WHERE refusal.subject_id = ${batchId}::uuid
  `;
}

async function cleanupTenantRows(): Promise<void> {
  // #1010's rows first: `refusal_events` has no-action foreign keys to
  // `accounts` and `businesses`, and its subject is a batch this sweep deletes.
  await sql()`DELETE FROM refusal_events WHERE account_id = ${accountId()}::uuid`;
  await sql()`DELETE FROM solicitation_outreach WHERE business_id = ${businessId}::uuid`;
  await sql()`DELETE FROM solicitation_asks WHERE business_id = ${businessId}::uuid`;
  await sql()`DELETE FROM solicitation_batches WHERE business_id = ${businessId}::uuid`;
  await sql()`DELETE FROM solicitation_contacts WHERE business_id = ${businessId}::uuid`;
  await sql()`DELETE FROM contact_csv_uploads WHERE business_id = ${businessId}::uuid`;
  await sql()`DELETE FROM agent_runs WHERE account_id = ${accountId()}::uuid`;
  await sql()`DELETE FROM account_audit_log WHERE account_id = ${accountId()}::uuid`;
}

describeWithDb(
  'latchSystemHalt against live local Postgres',
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
      await assertSchemaReady(db, [MIGRATION_091_SEND_MODE_SPINE_LIFECYCLE]);
      tenant = await seedTenantAccount(db, {
        userName: 'System Halt Owner',
        accountDisplayName: 'System Halt Account',
      });
      await seedLocation(db, tenant.accountId, {
        businessId,
        name: 'System Halt Location',
      });
      await db`
        INSERT INTO users (id, name, email, role)
        VALUES (${adminUserId}::uuid, 'System Halt Operator',
                ${`ops-${adminUserId}@repworth.test`}, 'admin')
      `;
    }, LIVE_DB_LOCK_HOOK_TIMEOUT_MS);

    afterEach(async () => {
      await cleanupTenantRows();
    }, 60_000);

    afterAll(async () => {
      try {
        if (db) {
          await db`DELETE FROM businesses WHERE id = ${businessId}::uuid`;
          await db`DELETE FROM users WHERE id = ${adminUserId}::uuid`;
          if (tenant) await cleanupTenantAccount(db, tenant);
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

    it('latchSystemHalt writes a NULL halted_by and no account_audit_log row', async () => {
      // Migration 091's `solicitation_batches_halt_consistency` requires
      // `halted_by IS NULL` for exactly `send_window_elapsed` and
      // `batch_expired`, so widening `actorUserId` to `string | null` makes the
      // signature express a rule the database already enforces. And the audit
      // sink stays EMPTY: `account_audit_log` is the control-plane record of a
      // RepWorth OPERATOR acting on someone else's account — a clock is not an
      // operator, and filing one there would make the log lie about who acted.
      const batch = await seedApprovedBatch();
      const parentRunId = await seedSendParent(batch.batchId);
      const rendered = await seedOutreach(batch, 'rendered');

      const result = await latchUnderLock(batch.batchId, 'send_window_elapsed');

      expect(result).toMatchObject({ status: 'latched', cancelledCount: 1 });
      const halt = await readHalt(batch.batchId);
      expect(halt.halted_at).not.toBeNull();
      expect(halt.halt_reason).toBe('send_window_elapsed');
      expect(halt.halted_by).toBeNull();
      expect(await countAuditRows()).toBe(0);

      expect(await readOutreachStatus(rendered)).toEqual({
        delivery_status: 'cancelled',
        disposition_reason: 'send_window_elapsed',
      });

      const steps = await readHaltSteps(parentRunId);
      expect(steps).toHaveLength(1);
      expect(jsonObject(steps[0]!.detail)).toMatchObject({
        halt_reason: 'send_window_elapsed',
        halted_by: null,
        cancelled_count: 1,
      });

      // The latch NEVER terminalizes the Send batch parent itself —
      // `closeBatchIfSettled` owns that, reached through the latch's join.
      expect(halt.send_closed_at).not.toBeNull();
    });

    it('a platform halt writes a refusal_events row even though it writes no account_audit_log row', async () => {
      // #1010 T5. The two receipts are DIFFERENT ACTS with different rules, and
      // this batch is where they visibly diverge. `account_audit_log` records a
      // RepWorth OPERATOR acting on someone else's account — filing a
      // platform-wide sending halt there would make the log claim a human acted
      // — while the Refusal ledger records what RepWorth DECLINED TO DO, which a
      // platform halt certainly is. `latchHalt`'s ledger write is its own
      // statement, unconditional on `audit`, and that is what makes the
      // asymmetry invisible to it.
      const batch = await seedApprovedBatch();
      const parentRunId = await seedSendParent(batch.batchId);
      const rendered = await seedOutreach(batch, 'rendered');

      const result = await latchUnderLock(batch.batchId, 'platform_halt');

      expect(result).toMatchObject({ status: 'latched', cancelledCount: 1 });
      expect(await countAuditRows(), 'a clock is not an operator').toBe(0);

      const refusals = await readRefusals(batch.batchId);
      // ONE row, against the BATCH — never one per cancelled Outreach row.
      expect(refusals).toHaveLength(1);
      expect(refusals[0]).toMatchObject({
        refusal_source: 'batch_halted',
        // The reason VERBATIM, and the category this lane's map assigns it —
        // `platform_halt` and `admin_halt` share `autonomy_paused` and stay two
        // distinct codes, because `refusal_code` is stored as written.
        refusal_code: 'platform_halt',
        refusal_category: BATCH_HALTED_REFUSAL_CATEGORIES.platform_halt,
        subject_type: 'solicitation_batch',
        subject_id: batch.batchId,
        account_id: accountId(),
        business_id: businessId,
      });
      // `occurred_at` IS the `halted_at` the same `NOW()` wrote, compared inside
      // Postgres at full precision.
      expect(refusals[0]!.matches_halted_at).toBe(true);

      // The batch really halted and really cancelled, so the audit zero above is
      // an absent RECEIPT rather than an absent halt.
      expect((await readHalt(batch.batchId)).halt_reason).toBe('platform_halt');
      expect(await readOutreachStatus(rendered)).toEqual({
        delivery_status: 'cancelled',
        disposition_reason: 'platform_halt',
      });
      expect(await readHaltSteps(parentRunId)).toHaveLength(1);
    });

    it('a second system halt on an already halted batch writes nothing', async () => {
      // `latchSystemHalt` skips the two owner arms' `state === 'halted'` guard —
      // there is no actor to refuse — so `latchHalt`'s `AND halted_at IS NULL`
      // CAS becomes the ONLY defense. Issue #895(b) proved that arm is
      // unreachable through both existing arms; from this arm it is the contract.
      const batch = await seedApprovedBatch();
      const parentRunId = await seedSendParent(batch.batchId);
      await seedOutreach(batch, 'rendered');

      const first = await latchUnderLock(batch.batchId, 'send_window_elapsed');
      const firstHalt = await readHalt(batch.batchId);
      const second = await latchUnderLock(batch.batchId, 'batch_expired');

      expect(first).toMatchObject({ status: 'latched' });
      expect(second).toEqual({ status: 'not_latched' });

      const after = await readHalt(batch.batchId);
      expect(after.halt_reason).toBe('send_window_elapsed');
      expect(after.halted_at?.getTime()).toBe(firstHalt.halted_at?.getTime());
      expect(after.halted_by).toBeNull();
      // No second receipt, no second step, no audit row from either call.
      expect(await readHaltSteps(parentRunId)).toHaveLength(1);
      expect(await countAuditRows()).toBe(0);
    });

    it('latchSystemHalt never cancels a sending Outreach row', async () => {
      // Round-1 finding 9. Cancelling a `sending` row would discard a real
      // provider delivery from lifecycle accounting, so a later batch could
      // treat that contact as unsent and email them again. Halt means "no
      // further sends", not "undo" — the row is past the point of no return and
      // the `unknown` sweep is the only writer that may terminalize it.
      const batch = await seedApprovedBatch();
      const parentRunId = await seedSendParent(batch.batchId);
      const rendered = await seedOutreach(batch, 'rendered');
      const queued = await seedOutreach(batch, 'queued');
      const sending = await seedOutreach(batch, 'sending');

      const result = await latchUnderLock(batch.batchId, 'batch_expired');

      expect(result).toMatchObject({ status: 'latched', cancelledCount: 2 });
      expect(await readOutreachStatus(rendered)).toEqual({
        delivery_status: 'cancelled',
        disposition_reason: 'batch_expired',
      });
      expect(await readOutreachStatus(queued)).toEqual({
        delivery_status: 'cancelled',
        disposition_reason: 'batch_expired',
      });
      expect(await readOutreachStatus(sending)).toEqual({
        delivery_status: 'sending',
        disposition_reason: null,
      });

      // The receipt is truthful about an actor-less halt AND about what it
      // cancelled: two rows, not three.
      const steps = await readHaltSteps(parentRunId);
      expect(steps).toHaveLength(1);
      expect(jsonObject(steps[0]!.detail)).toMatchObject({
        halt_reason: 'batch_expired',
        halted_by: null,
        cancelled_count: 2,
      });

      // A live `sending` row means the batch is NOT settled, so the join left
      // the parent alone.
      expect((await readHalt(batch.batchId)).send_closed_at).toBeNull();
    });

    // Property tests (fast-check): the house style for invariant-level coverage.
    describe('Halt latch invariants', () => {
      it('property: the Halt latch is monotone under arbitrary halt orderings', async () => {
        // The latch is monotone ACROSS ACTOR CLASSES, not merely within one.
        // Delete `latchHalt`'s `AND halted_at IS NULL` and this goes RED — which
        // is the whole point of writing it: the two owner arms refuse at
        // `state === 'halted'` before ever reaching the CAS, so no example test
        // built on them can reach that arm, and the system arm skips the guard.
        const arms = ['owner', 'admin', 'send_window_elapsed', 'batch_expired'] as const;

        await fc.assert(
          fc.asyncProperty(
            fc.uniqueArray(fc.constantFrom(...arms), { minLength: 2, maxLength: 4 }),
            async (ordering) => {
              const batch = await seedApprovedBatch();
              const parentRunId = await seedSendParent(batch.batchId);
              await seedOutreach(batch, 'rendered');
              try {
                for (const arm of ordering) {
                  if (arm === 'owner') {
                    await haltBatch(sql(), {
                      batchId: batch.batchId,
                      accountId: accountId(),
                      businessId,
                      haltedByUserId: userId(),
                    });
                  } else if (arm === 'admin') {
                    await adminHaltBatch(sql(), {
                      batchId: batch.batchId,
                      accountId: accountId(),
                      businessId,
                      actorUserId: adminUserId,
                      note: ADMIN_NOTE,
                    });
                  } else {
                    await latchUnderLock(batch.batchId, arm);
                  }
                }

                const halt = await readHalt(batch.batchId);
                const first = ordering[0]!;
                // The batch is mid-drip (`sending_started_at` is stamped), so
                // the owner arm derives `owner_halt`, never `owner_veto`.
                const expectedReason =
                  first === 'owner' ? 'owner_halt' : first === 'admin' ? 'admin_halt' : first;

                // 1. halted_at / halt_reason are the FIRST halt's values.
                expect(halt.halt_reason).toBe(expectedReason);
                expect(halt.halted_at).not.toBeNull();
                // 2. actor presence follows the reason, which is 091's CHECK.
                if (first === 'owner') expect(halt.halted_by).toBe(userId());
                else if (first === 'admin') expect(halt.halted_by).toBe(adminUserId);
                else expect(halt.halted_by).toBeNull();
                // 3. exactly ONE batch_halted step, whatever the ordering.
                expect(await readHaltSteps(parentRunId)).toHaveLength(1);
                // 4. at most one account_audit_log row — and exactly one only
                //    when the ADMIN arm won, because D7 is admin-only.
                const auditRows = await countAuditRows();
                expect(auditRows).toBeLessThanOrEqual(1);
                expect(auditRows).toBe(first === 'admin' ? 1 : 0);
              } finally {
                await cleanupTenantRows();
              }
            },
          ),
          // Deliberately small: every run reseeds a batch, an ask, an outreach
          // row and a send parent against real Postgres. Eleven orderings cover
          // the four arms in first position several times over.
          { numRuns: 12 },
        );
      });
    });
  },
);
