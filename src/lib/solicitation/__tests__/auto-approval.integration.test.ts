// Live-DB half of the Auto-approval lane (#631,
// docs/superpowers/plans/2026-08-23-631-auto-approval-lane.md). Task 4 turns
// the verb + finale titles into real tests against local Postgres at head
// (113 applied): the auto-approve CAS, its savepoint/23505 classification,
// the same-tx Veto-notice enqueue (invariant #2), the owner-won race, and the
// generation-finale hook driven through the REAL `generateAsksForBatch`.
// Applies NO migration SQL (#573): `pnpm test:db:setup` provisions to head;
// assertSchemaReady asserts it.
//
// The four generation-finale titles below were originally scaffolded in
// ask-generation.integration.test.ts per the plan, but that file is one of
// the #656 promised-test files postal-address.test.ts's integrity meta-test
// asserts is FREE of `it.todo`/`it.skip` — so they live here instead (see
// docs/superpowers/plans/631-auto-approval-lane-deviations.md, dated entry).
// They drive `generateAsksForBatch` / `regenerateAsk` by import, which is
// unaffected by which file drives them.
//
// The five `anchorVetoDeadlines` titles are real tests below (#631 Task 6):
// they seed `notification_deliveries` rows directly with `sent_at` (the
// veto-notice WORKER is not under test here) and a `batch_approved` step
// recording the granted window, then drive `anchorVetoDeadlines` by import.
//
// Only the SPEND boundary is faked (the ask-generation.integration.test.ts
// pattern): a canned `runLlmTask` and a mocked cost tracker, because this
// suite measures approval writes, not reservations. `recordApiCost` is a
// DELEGATING spy (approval.integration.test.ts pattern) so ONE test can run
// an owner approval inside the real post-render / pre-finale race window.

import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import type postgresType from 'postgres';
import type { TransactionSql } from 'postgres';
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
  MIGRATION_088_SOLICITATION_BATCH_EXECUTOR,
  MIGRATION_091_SEND_MODE_SPINE_LIFECYCLE,
  MIGRATION_099_SOLICITATION_POSTAL_ADDRESS,
  MIGRATION_113_SOLICITATION_AUTO_APPROVAL_LANE,
} from '@/lib/shared/__tests__/helpers/schema-ready';
import {
  cleanupTenantAccount,
  seedTenantAccount,
  type TenantSeed,
} from '@/lib/shared/__tests__/live-db-tenant';
import { insertOutreach, seedContactCsvUpload } from '@/lib/shared/__tests__/helpers/outreach-fixture';

const llmMocks = vi.hoisted(() => ({ runLlmTask: vi.fn() }));
const costMocks = vi.hoisted(() => ({
  reserveCost: vi.fn(),
  finalizeCost: vi.fn(),
  releaseCost: vi.fn(),
  checkAskRegenBudget: vi.fn(),
}));
// Delegating spy — forwards to the real implementation so every test keeps
// real api_costs writes; NEVER reset (a reset would drop the delegation).
// The owner-race test uses mockImplementationOnce, which pops itself.
const auditSpies = vi.hoisted(() => ({ recordApiCost: vi.fn() }));

vi.mock('@/lib/llm/run-task', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/llm/run-task')>()),
  runLlmTask: llmMocks.runLlmTask,
}));
vi.mock('@/lib/costs/tracker', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/costs/tracker')>()),
  reserveCost: costMocks.reserveCost,
  finalizeCost: costMocks.finalizeCost,
  releaseCost: costMocks.releaseCost,
  checkAskRegenBudget: costMocks.checkAskRegenBudget,
}));
vi.mock('@/lib/costs/audit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/costs/audit')>();
  auditSpies.recordApiCost.mockImplementation(actual.recordApiCost);
  return { ...actual, recordApiCost: auditSpies.recordApiCost };
});

import { OPENAI_MODEL } from '@/lib/llm/tasks';
import { QUEUE_NAMES } from '@/lib/shared/queue-names';
import { lockAutonomyAccount } from '@/lib/auto-approval/account-lock';
import { acquireSolicitationBatchLock } from '../batch-builder';
import { approveBatch, type ApproveBatchResult } from '../approval';
import { generateAsksForBatch, regenerateAsk } from '../ask-generation';
import {
  anchorVetoDeadlines,
  autoApproveBatch,
  runFinaleAutoApproval,
  type AutoApproveOutcome,
  type FinaleAutoApprovalOutcome,
} from '../auto-approval';

const testDatabaseUrl = resolveTestDatabaseUrl();

const businessId = randomUUID();
const BUSINESS_NAME = 'Auto Approval Business';
// Attested from the start so freshly generated children pass the postal
// footer lint and RENDER (the sibling suite's attested-tuple arrangement) —
// this suite needs live rows, not the fail-closed path.
const POSTAL_ADDRESS = '789 Lavaca St\nAustin, TX 78701';
const VETO_TOPIC = QUEUE_NAMES.SOLICITATION_VETO_NOTICE;

let db: postgresType.Sql | undefined;
let featureDatabaseLock: LiveDbLock | undefined;
let tenant: TenantSeed | undefined;
let sendFlagBefore: string | undefined;
let autoFlagBefore: string | undefined;

function sql(): postgresType.Sql {
  if (!db) throw new Error('auto-approval integration database was not initialized');
  return db;
}

function accountId(): string {
  if (!tenant) throw new Error('auto-approval integration tenant was not seeded');
  return tenant.accountId;
}

function userId(): string {
  if (!tenant) throw new Error('auto-approval integration tenant was not seeded');
  return tenant.userId;
}

/** PgBouncer JSONB-as-string guard (the CLAUDE.md carve-out). */
function parseJsonb(value: unknown): Record<string, unknown> {
  const parsed: unknown = typeof value === 'string' ? JSON.parse(value) : value;
  return parsed as Record<string, unknown>;
}

/** The D20 opt-in: the Solicitation account-default policy row. */
async function seedPolicyRow(vetoWindowMinutes = 60): Promise<void> {
  await sql()`
    INSERT INTO auto_approval_policies (
      id, account_id, location_id, persona, action_class,
      veto_window_minutes, daily_send_cap
    ) VALUES (
      ${randomUUID()}::uuid, ${accountId()}::uuid, NULL, 'solicitation', 'sending',
      ${vetoWindowMinutes}, 25
    )
  `;
}

interface SeededBatch {
  batchId: string;
  uploadId: string;
}

/** One built batch on its OWN upload (source_upload_id is unique). */
async function seedBatch(): Promise<SeededBatch> {
  const uploadId = await seedContactCsvUpload(sql(), {
    accountId: accountId(),
    businessId,
    attestedByUserId: userId(),
    filenamePrefix: 'auto-approval',
    attestationVersion: 'auto-approval-test',
  });
  const batchId = randomUUID();
  await sql()`
    INSERT INTO solicitation_batches (
      id, account_id, business_id, source_upload_id, created_at, built_at
    ) VALUES (
      ${batchId}::uuid, ${accountId()}::uuid, ${businessId}::uuid,
      ${uploadId}::uuid, NOW() - INTERVAL '40 days', NOW() - INTERVAL '1 hour'
    )
  `;
  return { batchId, uploadId };
}

/** The Send batch parent the verb's `batch_approved` step lands on. */
async function seedSendParent(batchId: string): Promise<string> {
  const runId = randomUUID();
  await sql()`
    INSERT INTO agent_runs (
      id, account_id, business_id, kind, subject_type, subject_id,
      status, started_at, correlation_id
    ) VALUES (
      ${runId}::uuid, ${accountId()}::uuid, ${businessId}::uuid,
      'solicitation_send_batch', 'solicitation_batch', ${batchId},
      'running', NOW() - INTERVAL '1 minute', 'auto-approval-integration'
    )
  `;
  return runId;
}

interface SeededAsk {
  askId: string;
  contactId: string;
}

/** One send ask on its own contact, with one visit (the §1.1 inputs — the
 *  visit matters for the tests that let generation actually render). */
async function seedSendAsk(batchId: string, uploadId: string, n: number): Promise<SeededAsk> {
  const contactId = randomUUID();
  const askId = randomUUID();
  await sql()`
    INSERT INTO solicitation_contacts (id, business_id, name, email, created_by_upload_id)
    VALUES (
      ${contactId}::uuid, ${businessId}::uuid, ${`Alice Candidate${n}`},
      ${`${contactId}@example.test`}, ${uploadId}::uuid
    )
  `;
  await sql()`
    INSERT INTO solicitation_visits (id, contact_id, business_id, visit_date, note, upload_id)
    VALUES (
      ${randomUUID()}::uuid, ${contactId}::uuid, ${businessId}::uuid,
      (NOW() - interval '3 days')::date, NULL, ${uploadId}::uuid
    )
  `;
  await sql()`
    INSERT INTO solicitation_asks (
      id, account_id, business_id, batch_id, contact_id,
      status, withheld_reason, evidence, decided_at
    ) VALUES (
      ${askId}::uuid, ${accountId()}::uuid, ${businessId}::uuid,
      ${batchId}::uuid, ${contactId}::uuid, 'send', NULL,
      ${sql().json({ decision: 'send' })}, NOW()
    )
  `;
  return { askId, contactId };
}

/** A live rendered attempt — the state a finished generation leaves behind. */
async function seedRenderedAttempt(batchId: string, ask: SeededAsk): Promise<string> {
  return insertOutreach(sql(), {
    accountId: accountId(),
    businessId,
    batchId,
    askId: ask.askId,
    contactId: ask.contactId,
    attemptNo: 1,
    deliveryStatus: 'rendered',
    renderedAt: sql()`NOW() - INTERVAL '1 minute'`,
  });
}

/** The owned dispatched outbox attempt every generation door completes —
 *  the sibling suite's fixture shortcut, topic passed as a bind. */
async function seedDispatchedOutboxRow(
  batchId: string,
  topic = 'generate_solicitation_asks',
): Promise<{ outboxId: string; attempt: number }> {
  const outboxId = randomUUID();
  await sql()`
    INSERT INTO job_outbox (
      id, topic, aggregate_type, aggregate_id, payload,
      status, attempts, dispatched_at
    ) VALUES (
      ${outboxId}::uuid, ${topic}, 'solicitation_batch',
      ${batchId}::uuid, ${sql().json({ batch_id: batchId, business_id: businessId })},
      'dispatched', 1, NOW()
    )
  `;
  return { outboxId, attempt: 1 };
}

interface BatchApprovalRow {
  approved_at: string | null;
  approval_method: string | null;
  approved_by_user_id: string | null;
  veto_deadline_at: string | null;
}

async function readBatchRow(batchId: string): Promise<BatchApprovalRow> {
  const [row] = await sql()<BatchApprovalRow[]>`
    SELECT approved_at::text AS approved_at,
           approval_method,
           approved_by_user_id::text AS approved_by_user_id,
           veto_deadline_at::text AS veto_deadline_at
    FROM solicitation_batches
    WHERE id = ${batchId}::uuid
      AND account_id = ${accountId()}::uuid
      AND business_id = ${businessId}::uuid
  `;
  if (!row) throw new Error(`auto-approval integration: batch ${batchId} missing`);
  return row;
}

async function readVetoNoticeRows(
  batchId: string,
): Promise<{ status: string; aggregate_type: string; payload: unknown }[]> {
  return sql()<{ status: string; aggregate_type: string; payload: unknown }[]>`
    SELECT status, aggregate_type, payload
    FROM job_outbox
    WHERE topic = ${VETO_TOPIC} AND aggregate_id = ${batchId}::uuid
  `;
}

async function readBatchApprovedSteps(runId: string): Promise<{ detail: unknown }[]> {
  return sql()<{ detail: unknown }[]>`
    SELECT detail FROM agent_run_steps
    WHERE agent_run_id = ${runId}::uuid AND step_key = 'batch_approved'
  `;
}

async function readVetoWindowGrantedSteps(runId: string): Promise<{ detail: unknown }[]> {
  return sql()<{ detail: unknown }[]>`
    SELECT detail FROM agent_run_steps
    WHERE agent_run_id = ${runId}::uuid AND step_key = 'veto_window_granted'
  `;
}

/** The `batch_approved` step `autoApproveBatch` would have written — seeded
 *  directly here because these anchor tests are about the ANCHOR phase, not
 *  the approve verb (Task 4's own tests already cover that write). */
async function seedBatchApprovedStep(runId: string, vetoWindowMinutes: number): Promise<void> {
  await sql()`
    INSERT INTO agent_run_steps (
      id, agent_run_id, step_index, step_key, attributed_agent, status, detail
    ) VALUES (
      ${randomUUID()}::uuid, ${runId}::uuid, 1, 'batch_approved', 'solicitation', 'completed',
      ${sql().json({
        approval_method: 'auto_policy',
        approved_count: 1,
        veto_window_minutes: vetoWindowMinutes,
      })}
    )
  `;
}

/** Stamps a `seedBatch()` row `auto_policy`-approved with no anchored
 *  deadline — the state `anchorVetoDeadlines`'s scan selects. */
async function markAutoApproved(batchId: string): Promise<void> {
  await sql()`
    UPDATE solicitation_batches
    SET approved_at = NOW() - INTERVAL '5 minutes', approval_method = 'auto_policy'
    WHERE id = ${batchId}::uuid AND account_id = ${accountId()}::uuid AND business_id = ${businessId}::uuid
  `;
}

/** 091's halt-consistency CHECK: `owner_halt` requires `halted_by` set. */
async function haltBatch(batchId: string): Promise<void> {
  await sql()`
    UPDATE solicitation_batches
    SET halted_at = NOW(), halt_reason = 'owner_halt', halted_by = ${userId()}::uuid
    WHERE id = ${batchId}::uuid AND account_id = ${accountId()}::uuid AND business_id = ${businessId}::uuid
  `;
}

/** A `notification_deliveries` row for the Veto notice — the worker is NOT
 *  under test, so the anchor suite seeds provider-accepted sends directly.
 *  `recipient` defaults to a UNIQUE address per call — migration 113's
 *  `notification_deliveries_solicitation_veto_notice_claim` is a partial
 *  unique index on `(entity_id, channel, recipient)`, so two "second channel
 *  retried" rows for the SAME batch need distinct recipients to coexist. */
async function seedVetoNoticeDelivery(
  entityId: string,
  opts: { sentAgo?: string; template?: string; recipient?: string; failedAgo?: string } = {},
): Promise<void> {
  await sql()`
    INSERT INTO notification_deliveries (
      id, business_id, account_id, entity_id, channel, recipient, template, sent_at, failed_at
    ) VALUES (
      ${randomUUID()}::uuid, ${businessId}::uuid, ${accountId()}::uuid,
      ${entityId}::uuid, 'email', ${opts.recipient ?? `owner-${randomUUID()}@example.test`},
      ${opts.template ?? 'solicitation_veto_notice'},
      NOW() - ${opts.sentAgo ?? '10 minutes'}::interval,
      ${opts.failedAgo === undefined ? null : sql()`NOW() - ${opts.failedAgo}::interval`}
    )
  `;
}

/** Compares `veto_deadline_at` against `MIN(sent_at) + window` entirely IN
 *  SQL — never round-tripped through a JS `Date`, which truncates the
 *  microseconds postgres.js decodes `timestamptz` into (#520). */
async function vetoDeadlineMatchesFirstSentPlusWindow(
  batchId: string,
  vetoWindowMinutes: number,
): Promise<boolean> {
  const [row] = await sql()<{ matches: boolean | null }[]>`
    SELECT b.veto_deadline_at = (
      (SELECT MIN(nd.sent_at) FROM notification_deliveries nd
        WHERE nd.entity_id = ${batchId}::uuid
          AND nd.template = 'solicitation_veto_notice'
          AND nd.sent_at IS NOT NULL)
      + make_interval(mins => ${vetoWindowMinutes})
    ) AS matches
    FROM solicitation_batches b
    WHERE b.id = ${batchId}::uuid
  `;
  return row?.matches === true;
}

async function findSendParent(batchId: string): Promise<{ id: string; status: string }> {
  const [parent] = await sql()<{ id: string; status: string }[]>`
    SELECT id, status FROM agent_runs
    WHERE kind = 'solicitation_send_batch'
      AND subject_type = 'solicitation_batch'
      AND subject_id = ${batchId}
      AND account_id = ${accountId()}::uuid
      AND business_id = ${businessId}::uuid
  `;
  if (!parent) throw new Error(`auto-approval integration: send parent missing for ${batchId}`);
  return parent;
}

async function lockBatchRow(tx: TransactionSql, batchId: string): Promise<void> {
  const locked = await tx<{ id: string }[]>`
    SELECT id FROM solicitation_batches
    WHERE id = ${batchId}::uuid
      AND account_id = ${accountId()}::uuid
      AND business_id = ${businessId}::uuid
    FOR UPDATE
  `;
  if (locked.count === 0) {
    throw new Error(`auto-approval integration: batch ${batchId} vanished before its lock`);
  }
}

/** The finale's exact lock order (B11: advisory → batch row), then the
 *  extracted finale hook — the account lock and the gate live inside it. */
async function driveFinaleAutoApproval(
  batchId: string,
  parentRunId: string,
): Promise<FinaleAutoApprovalOutcome> {
  return sql().begin(async (tx): Promise<FinaleAutoApprovalOutcome> => {
    await acquireSolicitationBatchLock(tx, businessId);
    await lockBatchRow(tx, batchId);
    return runFinaleAutoApproval(tx, {
      batchId,
      accountId: accountId(),
      businessId,
      sendParentRunId: parentRunId,
    });
  });
}

describeWithDb(
  'auto approval over live local Postgres',
  { enabled: Boolean(testDatabaseUrl), timeout: 60_000 },
  () => {
    beforeAll(async () => {
      const databaseUrl = assertLocalTestDatabaseUrl(testDatabaseUrl);
      featureDatabaseLock = await acquireLiveDbLock(databaseUrl);
      db = postgres(databaseUrl, { max: 2, prepare: false });
      await assertSchemaReady(db, [
        MIGRATION_088_SOLICITATION_BATCH_EXECUTOR,
        MIGRATION_091_SEND_MODE_SPINE_LIFECYCLE,
        MIGRATION_099_SOLICITATION_POSTAL_ADDRESS,
        MIGRATION_113_SOLICITATION_AUTO_APPROVAL_LANE,
      ]);

      tenant = await seedTenantAccount(db, {
        userName: 'Auto Approval Owner',
        accountDisplayName: 'Auto Approval Account',
      });
      await db`
        UPDATE accounts
        SET subscription_status = 'active', subscription_tier = 'autopilot'
        WHERE id = ${tenant.accountId}::uuid
      `;
      await db`
        INSERT INTO businesses (
          id, name, owner_name, owner_email, account_id, subscription_status, category,
          solicitation_postal_address,
          solicitation_postal_address_attested_at,
          solicitation_postal_address_attested_by_user_id,
          solicitation_postal_address_attestation_version,
          solicitation_postal_address_attested_digest
        ) VALUES (
          ${businessId}::uuid, ${BUSINESS_NAME}, 'Auto Owner',
          ${tenant.ownerEmail}, ${tenant.accountId}::uuid, 'active', 'retail',
          ${POSTAL_ADDRESS}, NOW(), ${tenant.userId}::uuid,
          'postal_address_attestation_v1',
          encode(sha256(convert_to(${POSTAL_ADDRESS}::text, 'UTF8')), 'hex')
        )
      `;

      sendFlagBefore = process.env.SOLICITATION_SEND_ENABLED;
      autoFlagBefore = process.env.SOLICITATION_AUTO_APPROVAL_ENABLED;
      process.env.SOLICITATION_SEND_ENABLED = 'true';
      process.env.SOLICITATION_AUTO_APPROVAL_ENABLED = 'true';
    }, LIVE_DB_LOCK_HOOK_TIMEOUT_MS);

    beforeEach(async () => {
      llmMocks.runLlmTask.mockReset();
      costMocks.reserveCost.mockReset();
      costMocks.finalizeCost.mockReset();
      costMocks.releaseCost.mockReset();
      costMocks.checkAskRegenBudget.mockReset();
      const structured = {
        subject: `Thanks for visiting ${BUSINESS_NAME}`,
        body: `Hi Alice, thanks for coming by ${BUSINESS_NAME}. Would you share how it went?`,
      };
      llmMocks.runLlmTask.mockResolvedValue({
        text: JSON.stringify(structured),
        provider: 'openai',
        model: OPENAI_MODEL,
        usage: { promptTokens: 500, completionTokens: 120 },
        structured,
      });
      costMocks.reserveCost.mockResolvedValue('2026-08-23');
      costMocks.finalizeCost.mockResolvedValue(undefined);
      costMocks.releaseCost.mockResolvedValue(undefined);
      costMocks.checkAskRegenBudget.mockResolvedValue(undefined);

      await seedPolicyRow();
    });

    afterEach(async () => {
      process.env.SOLICITATION_SEND_ENABLED = 'true';
      process.env.SOLICITATION_AUTO_APPROVAL_ENABLED = 'true';
      if (!db) return;
      await db`DELETE FROM solicitation_outreach WHERE business_id = ${businessId}::uuid`;
      await db`DELETE FROM solicitation_asks WHERE business_id = ${businessId}::uuid`;
      await db`DELETE FROM solicitation_visits WHERE business_id = ${businessId}::uuid`;
      await db`DELETE FROM solicitation_contacts WHERE business_id = ${businessId}::uuid`;
      await db`DELETE FROM api_costs WHERE business_id = ${businessId}::uuid`;
      await db`DELETE FROM notification_deliveries WHERE business_id = ${businessId}::uuid`;
      await db`
        DELETE FROM agent_run_steps
        WHERE agent_run_id IN (
          SELECT id FROM agent_runs WHERE business_id = ${businessId}::uuid
        )
      `;
      await db`DELETE FROM agent_runs WHERE business_id = ${businessId}::uuid`;
      await db`
        DELETE FROM job_outbox
        WHERE aggregate_id IN (
          SELECT id FROM solicitation_batches WHERE business_id = ${businessId}::uuid
        )
      `;
      await db`DELETE FROM solicitation_batches WHERE business_id = ${businessId}::uuid`;
      await db`DELETE FROM contact_csv_uploads WHERE business_id = ${businessId}::uuid`;
      await db`DELETE FROM auto_approval_policies WHERE account_id = ${accountId()}::uuid`;
      await db`
        UPDATE accounts
        SET subscription_status = 'active', subscription_tier = 'autopilot'
        WHERE id = ${accountId()}::uuid
      `;
    });

    afterAll(async () => {
      if (sendFlagBefore === undefined) delete process.env.SOLICITATION_SEND_ENABLED;
      else process.env.SOLICITATION_SEND_ENABLED = sendFlagBefore;
      if (autoFlagBefore === undefined) delete process.env.SOLICITATION_AUTO_APPROVAL_ENABLED;
      else process.env.SOLICITATION_AUTO_APPROVAL_ENABLED = autoFlagBefore;
      try {
        if (db) {
          await db`DELETE FROM businesses WHERE id = ${businessId}::uuid`;
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
    }, 120_000);

    describe('autoApproveBatch', () => {
      it('auto-approves a built batch as auto_policy when all four conditions hold and records the spine step', async () => {
        const { batchId, uploadId } = await seedBatch();
        const parentRunId = await seedSendParent(batchId);
        const ask = await seedSendAsk(batchId, uploadId, 1);
        await seedRenderedAttempt(batchId, ask);

        const outcome = await driveFinaleAutoApproval(batchId, parentRunId);
        expect(outcome).toEqual({ status: 'approved', approvedCount: 1, vetoWindowMinutes: 60 });

        const row = await readBatchRow(batchId);
        expect(row.approved_at).not.toBeNull();
        expect(row.approval_method).toBe('auto_policy');
        // 091's approval-consistency CHECK: auto_policy carries NO approver id.
        expect(row.approved_by_user_id).toBeNull();
        // Decision 4: the deadline is NOT stamped at approval — the Veto
        // anchor CASes it later from the first provider-accepted notice send.
        expect(row.veto_deadline_at).toBeNull();

        const steps = await readBatchApprovedSteps(parentRunId);
        expect(steps).toHaveLength(1);
        const detail = parseJsonb(steps[0]!.detail);
        expect(detail).toMatchObject({
          approval_method: 'auto_policy',
          approved_count: 1,
          veto_window_minutes: 60,
        });
        expect('approved_by_user_id' in detail).toBe(false);
      });

      it('enqueues the veto notice through job_outbox in the same transaction as the auto approval', async () => {
        const { batchId, uploadId } = await seedBatch();
        const parentRunId = await seedSendParent(batchId);
        const ask = await seedSendAsk(batchId, uploadId, 1);
        await seedRenderedAttempt(batchId, ask);

        // Arm 1 — atomicity. The notice row is visible INSIDE the verb's
        // transaction, and rolling that transaction back takes BOTH writes
        // with it: one transaction, not a write plus a separate enqueue.
        class FinaleRollback extends Error {}
        await expect(
          sql().begin(async (tx) => {
            await acquireSolicitationBatchLock(tx, businessId);
            await lockBatchRow(tx, batchId);
            await lockAutonomyAccount(tx, accountId());
            const outcome = await autoApproveBatch(tx, {
              batchId,
              accountId: accountId(),
              businessId,
              sendParentRunId: parentRunId,
              vetoWindowMinutes: 60,
              correlationId: 'same-tx-proof',
            });
            expect(outcome).toMatchObject({ status: 'approved' });
            const inTx = await tx<{ id: string }[]>`
              SELECT id FROM job_outbox
              WHERE topic = ${VETO_TOPIC} AND aggregate_id = ${batchId}::uuid
            `;
            expect(inTx).toHaveLength(1);
            throw new FinaleRollback('roll the finale back');
          }),
        ).rejects.toBeInstanceOf(FinaleRollback);
        expect((await readBatchRow(batchId)).approved_at).toBeNull();
        expect(await readVetoNoticeRows(batchId)).toHaveLength(0);

        // Arm 2 — a committed transaction lands both writes together.
        const outcome = await sql().begin(async (tx): Promise<AutoApproveOutcome> => {
          await acquireSolicitationBatchLock(tx, businessId);
          await lockBatchRow(tx, batchId);
          await lockAutonomyAccount(tx, accountId());
          return autoApproveBatch(tx, {
            batchId,
            accountId: accountId(),
            businessId,
            sendParentRunId: parentRunId,
            vetoWindowMinutes: 60,
            correlationId: 'same-tx-proof',
          });
        });
        expect(outcome).toEqual({ status: 'approved', approvedCount: 1, vetoWindowMinutes: 60 });

        const notices = await readVetoNoticeRows(batchId);
        expect(notices).toHaveLength(1);
        expect(notices[0]).toMatchObject({ status: 'pending', aggregate_type: 'solicitation_batch' });
        expect(parseJsonb(notices[0]!.payload)).toEqual({
          batch_id: batchId,
          business_id: businessId,
          correlation_id: 'same-tx-proof',
        });
      });

      it('falls back to owner review when the one-active-send-batch index rejects the auto approval', async () => {
        // A SECOND approved batch for the same business already holds 091's
        // one-active-send slot, so the CAS's approved_at stamp trips the
        // partial unique index inside the savepoint.
        const holder = await seedBatch();
        await sql()`
          UPDATE solicitation_batches
          SET approved_at = NOW(), approval_method = 'owner',
              approved_by_user_id = ${userId()}::uuid,
              veto_deadline_at = NOW() + make_interval(mins => 30)
          WHERE id = ${holder.batchId}::uuid
            AND account_id = ${accountId()}::uuid
            AND business_id = ${businessId}::uuid
        `;

        const { batchId, uploadId } = await seedBatch();
        const parentRunId = await seedSendParent(batchId);
        const ask = await seedSendAsk(batchId, uploadId, 1);
        await seedRenderedAttempt(batchId, ask);

        const outcome = await driveFinaleAutoApproval(batchId, parentRunId);
        expect(outcome).toEqual({ status: 'slot_held' });

        // Owner review keeps the batch: unapproved, no notice, no spine step
        // — and the savepoint kept the finale transaction healthy.
        expect((await readBatchRow(batchId)).approved_at).toBeNull();
        expect(await readVetoNoticeRows(batchId)).toHaveLength(0);
        expect(await readBatchApprovedSteps(parentRunId)).toHaveLength(0);
      });

      it('preserves an owner approval committed after the final render but before the generation finale', async () => {
        // Strongest arrangement the harness allows — the REAL race window,
        // driven through the real generateAsksForBatch (the alternative, a
        // direct autoApproveBatch call against a pre-approved batch, never
        // exercises the finale's own CAS): the last child render commits
        // inside persistChildRender, `recordApiCost` fires right after that
        // commit and BEFORE the finale opens, so `approveBatch` runs there —
        // its readiness gate passes (the render exists, batch still `built`)
        // and the finale's auto CAS must lose to a genuinely committed owner
        // approval, not to a fixture UPDATE.
        const { batchId, uploadId } = await seedBatch();
        await seedSendAsk(batchId, uploadId, 1);
        const handle = await seedDispatchedOutboxRow(batchId);

        const { recordApiCost: actualRecordApiCost } =
          await vi.importActual<typeof import('@/lib/costs/audit')>('@/lib/costs/audit');
        let approval: ApproveBatchResult | undefined;
        auditSpies.recordApiCost.mockImplementationOnce(
          async (...args: Parameters<typeof actualRecordApiCost>) => {
            approval = await approveBatch(sql(), {
              batchId,
              accountId: accountId(),
              businessId,
              approvedByUserId: userId(),
              excludedOutreachIds: [],
            });
            return actualRecordApiCost(...args);
          },
        );

        const result = await generateAsksForBatch(sql(), {
          batchId,
          businessId,
          outboxHandle: handle,
        });
        expect(result).toMatchObject({ rendered: 1, withheld: 0, failed: 0 });
        expect(approval).toMatchObject({ status: 'approved', approvedCount: 1 });

        // owner_won is a QUIET outcome: the owner approval survives intact
        // and the Auto-approval lane wrote nothing.
        const row = await readBatchRow(batchId);
        expect(row.approval_method).toBe('owner');
        expect(row.approved_by_user_id).toBe(userId());
        expect(await readVetoNoticeRows(batchId)).toHaveLength(0);
        const parent = await findSendParent(batchId);
        const steps = await readBatchApprovedSteps(parent.id);
        expect(steps).toHaveLength(1);
        expect(parseJsonb(steps[0]!.detail)).toMatchObject({ approval_method: 'owner' });
      });

      it('autoApproveBatch rethrows a 23505 from every constraint except solicitation_batches_one_active_send_per_business', async () => {
        const { batchId, uploadId } = await seedBatch();
        const parentRunId = await seedSendParent(batchId);
        const ask = await seedSendAsk(batchId, uploadId, 1);
        await seedRenderedAttempt(batchId, ask);

        // A REAL Postgres 23505 from a DIFFERENT constraint, raised INSIDE
        // the savepoint (abort-injection discipline: the failure must
        // originate in Postgres, and never via a temporary constraint — the
        // poison is a duplicate-id INSERT tripping the table's own pkey/uniq
        // pair). A get-only Proxy forwards the tagged-template call form
        // untouched (abortingExecutor precedent) and wraps ONLY `savepoint`,
        // so the violation escapes the callback exactly the way the real
        // one-active-send 23505 does — and must be RETHROWN, not absorbed.
        const poisonSavepoint = (tx: TransactionSql): TransactionSql =>
          new Proxy(tx, {
            get(target, prop) {
              if (prop !== 'savepoint') {
                const value: unknown = Reflect.get(target, prop);
                return typeof value === 'function'
                  ? (value as (...args: unknown[]) => unknown).bind(target)
                  : value;
              }
              return (cb: (sp: TransactionSql) => Promise<unknown>) =>
                target.savepoint(async (sp) => {
                  const result = await cb(sp);
                  await sp`
                    INSERT INTO solicitation_batches (id, account_id, business_id, source_upload_id)
                    VALUES (
                      ${batchId}::uuid, ${accountId()}::uuid,
                      ${businessId}::uuid, ${uploadId}::uuid
                    )
                  `;
                  return result;
                });
            },
          });

        let caught: unknown;
        await expect(
          sql().begin(async (tx) => {
            await acquireSolicitationBatchLock(tx, businessId);
            await lockBatchRow(tx, batchId);
            await lockAutonomyAccount(tx, accountId());
            try {
              await autoApproveBatch(poisonSavepoint(tx), {
                batchId,
                accountId: accountId(),
                businessId,
                sendParentRunId: parentRunId,
                vetoWindowMinutes: 60,
              });
            } catch (error) {
              caught = error;
              throw error;
            }
          }),
        ).rejects.toMatchObject({ code: '23505' });

        const constraint = (caught as { constraint_name?: string }).constraint_name;
        expect(constraint).toBeDefined();
        expect(constraint).not.toBe('solicitation_batches_one_active_send_per_business');

        // The rethrow aborted the whole transaction — nothing stuck.
        expect((await readBatchRow(batchId)).approved_at).toBeNull();
        expect(await readVetoNoticeRows(batchId)).toHaveLength(0);
        expect(await readBatchApprovedSteps(parentRunId)).toHaveLength(0);
      });

      it('the database-backed gate approves a trialing autopilot account', async () => {
        // Invariant #11: `trialing` is full access everywhere — the gate goes
        // through subscriptionGrantsFullAccess, never a raw === 'active'.
        await sql()`
          UPDATE accounts
          SET subscription_status = 'trialing', subscription_tier = 'autopilot'
          WHERE id = ${accountId()}::uuid
        `;
        const { batchId, uploadId } = await seedBatch();
        const parentRunId = await seedSendParent(batchId);
        const ask = await seedSendAsk(batchId, uploadId, 1);
        await seedRenderedAttempt(batchId, ask);

        const outcome = await driveFinaleAutoApproval(batchId, parentRunId);
        expect(outcome).toEqual({ status: 'approved', approvedCount: 1, vetoWindowMinutes: 60 });
        expect((await readBatchRow(batchId)).approval_method).toBe('auto_policy');
      });

      it('turning the auto flag on does not retroactively approve a previously built batch', async () => {
        process.env.SOLICITATION_AUTO_APPROVAL_ENABLED = 'false';
        const { batchId, uploadId } = await seedBatch();
        const ask = await seedSendAsk(batchId, uploadId, 1);
        await seedRenderedAttempt(batchId, ask);

        const declined = await generateAsksForBatch(sql(), {
          batchId,
          businessId,
          outboxHandle: await seedDispatchedOutboxRow(batchId),
        });
        expect(declined).toMatchObject({ skippedExisting: 1 });
        // A decline is a log line, never a spine step (decision 9), and it
        // writes nothing durable.
        expect((await readBatchRow(batchId)).approved_at).toBeNull();
        const parent = await findSendParent(batchId);
        expect(await readBatchApprovedSteps(parent.id)).toHaveLength(0);
        expect(await readVetoNoticeRows(batchId)).toHaveLength(0);

        // Flip the flag ON. The guarantee this test pins is EXACTLY this:
        // NO SWEEP approves pre-flip batches — enabling the flag by itself
        // moves nothing, and the already-built batch stays where the decline
        // left it...
        process.env.SOLICITATION_AUTO_APPROVAL_ENABLED = 'true';
        expect((await readBatchRow(batchId)).approved_at).toBeNull();
        expect(await readVetoNoticeRows(batchId)).toHaveLength(0);

        // ...and only a NEW generation finale evaluates the lane again. That
        // finale deciding WITH CURRENT STATE — and so approving a batch built
        // before the flip — is the locked decision-at-finale design, not a
        // retroactivity leak: the finale is the lane's ONE decision point,
        // and it reads the world as it is when it runs.
        const rerun = await generateAsksForBatch(sql(), {
          batchId,
          businessId,
          outboxHandle: await seedDispatchedOutboxRow(batchId),
        });
        expect(rerun).toMatchObject({ skippedExisting: 1 });
        expect((await readBatchRow(batchId)).approval_method).toBe('auto_policy');
      });
    });

    // Relocated from ask-generation.integration.test.ts — see file header.
    describe('auto-approval at the generation finale (#631)', () => {
      it('the initial ask-generation finale auto-approves and enqueues the Veto notice when every gate holds', async () => {
        const { batchId, uploadId } = await seedBatch();
        const ask = await seedSendAsk(batchId, uploadId, 1);
        await seedRenderedAttempt(batchId, ask);
        const handle = await seedDispatchedOutboxRow(batchId);

        const result = await generateAsksForBatch(sql(), {
          batchId,
          businessId,
          outboxHandle: handle,
          correlationId: 'finale-auto-approves',
        });
        expect(result).toMatchObject({ rendered: 0, withheld: 0, failed: 0, skippedExisting: 1 });

        const row = await readBatchRow(batchId);
        expect(row.approved_at).not.toBeNull();
        expect(row.approval_method).toBe('auto_policy');
        expect(row.approved_by_user_id).toBeNull();
        // Decision 4: the finale never stamps the deadline — the Veto anchor
        // does, from the first provider-accepted notice send.
        expect(row.veto_deadline_at).toBeNull();

        const notices = await readVetoNoticeRows(batchId);
        expect(notices).toHaveLength(1);
        expect(notices[0]).toMatchObject({ status: 'pending', aggregate_type: 'solicitation_batch' });
        expect(parseJsonb(notices[0]!.payload)).toEqual({
          batch_id: batchId,
          business_id: businessId,
          correlation_id: 'finale-auto-approves',
        });

        const parent = await findSendParent(batchId);
        expect(parent.status).toBe('running');
        const steps = await readBatchApprovedSteps(parent.id);
        expect(steps).toHaveLength(1);
        expect(parseJsonb(steps[0]!.detail)).toMatchObject({
          approval_method: 'auto_policy',
          approved_count: 1,
          veto_window_minutes: 60,
        });

        // The finale still completed its own outbox attempt (decision 9).
        const [outboxRow] = await sql()<{ status: string }[]>`
          SELECT status FROM job_outbox WHERE id = ${handle.outboxId}::uuid
        `;
        expect(outboxRow).toMatchObject({ status: 'completed' });
      });

      it('regenerateAsk never invokes the auto-approval lane', async () => {
        // Every auto condition holds — flags on, autopilot, live policy row —
        // and the regen door must still never evaluate the lane (locked
        // decision 1: regen exists only in `built`, i.e. only for batches the
        // lane already declined or lost).
        const { batchId, uploadId } = await seedBatch();
        await seedSendParent(batchId);
        const ask = await seedSendAsk(batchId, uploadId, 1);
        await seedRenderedAttempt(batchId, ask);

        await regenerateAsk(sql(), {
          batchId,
          businessId,
          askId: ask.askId,
          outboxHandle: await seedDispatchedOutboxRow(batchId, 'regenerate_solicitation_ask'),
          correlationId: 'regen-no-auto-lane',
        });

        expect((await readBatchRow(batchId)).approved_at).toBeNull();
        expect(await readVetoNoticeRows(batchId)).toHaveLength(0);
        const parent = await findSendParent(batchId);
        expect(await readBatchApprovedSteps(parent.id)).toHaveLength(0);
      });

      it('the real generation finale leaves the batch built when SOLICITATION_SEND_ENABLED is off', async () => {
        process.env.SOLICITATION_SEND_ENABLED = 'false';
        const { batchId, uploadId } = await seedBatch();
        const ask = await seedSendAsk(batchId, uploadId, 1);
        await seedRenderedAttempt(batchId, ask);
        const handle = await seedDispatchedOutboxRow(batchId);

        await generateAsksForBatch(sql(), { batchId, businessId, outboxHandle: handle });

        // The master flag stops the lane before anything runs: the attempt
        // completes as a no-op SUCCESS and the batch is left `built` —
        // unapproved, no notice, nothing for the release lane.
        const [outboxRow] = await sql()<{ status: string }[]>`
          SELECT status FROM job_outbox WHERE id = ${handle.outboxId}::uuid
        `;
        expect(outboxRow).toMatchObject({ status: 'completed' });
        const row = await readBatchRow(batchId);
        expect(row.approved_at).toBeNull();
        expect(row.approval_method).toBeNull();
        expect(await readVetoNoticeRows(batchId)).toHaveLength(0);
      });

      it('Judge unavailability at approval time does not block auto approval', async () => {
        // Decision 8 / #900: the Judge is release-owned. Approval succeeds
        // with the Judge flag hard-off — the exact condition that downgrades
        // a Reply-lane auto post at publish time.
        const judgeBefore = process.env.JUDGE_ENABLED;
        process.env.JUDGE_ENABLED = 'false';
        try {
          const { batchId, uploadId } = await seedBatch();
          const ask = await seedSendAsk(batchId, uploadId, 1);
          await seedRenderedAttempt(batchId, ask);

          const result = await generateAsksForBatch(sql(), {
            batchId,
            businessId,
            outboxHandle: await seedDispatchedOutboxRow(batchId),
          });
          expect(result).toMatchObject({ skippedExisting: 1 });
          expect((await readBatchRow(batchId)).approval_method).toBe('auto_policy');
          expect(await readVetoNoticeRows(batchId)).toHaveLength(1);
        } finally {
          if (judgeBefore === undefined) delete process.env.JUDGE_ENABLED;
          else process.env.JUDGE_ENABLED = judgeBefore;
        }
      });
    });

    // #631 Task 6 — the D9 Veto anchor CAS. Nested inside describeWithDb (not
    // a separate top-level describe) so these share the outer beforeAll's
    // `db`/`tenant`/`businessId` setup and the shared afterEach cleanup.
    describe('anchorVetoDeadlines (#631)', () => {
      it('anchors veto_deadline_at from the first sent notice exactly once via CAS', async () => {
        const { batchId } = await seedBatch();
        const parentRunId = await seedSendParent(batchId);
        await markAutoApproved(batchId);
        await seedBatchApprovedStep(parentRunId, 60);
        // Two sent notices — MIN(sent_at) must win, not the latest.
        await seedVetoNoticeDelivery(batchId, { sentAgo: '20 minutes' });
        await seedVetoNoticeDelivery(batchId, { sentAgo: '10 minutes' });

        const first = await anchorVetoDeadlines(sql(), 50);
        expect(first).toEqual({ handled: 1, failed: 0 });

        const row = await readBatchRow(batchId);
        expect(row.veto_deadline_at).not.toBeNull();
        // SQL-side comparison — never a JS Date round-trip (#520).
        expect(await vetoDeadlineMatchesFirstSentPlusWindow(batchId, 60)).toBe(true);

        const steps = await readVetoWindowGrantedSteps(parentRunId);
        expect(steps).toHaveLength(1);
        const detail = parseJsonb(steps[0]!.detail);
        expect(detail).toMatchObject({ granted_window_minutes: 60, actor: 'system' });
        expect(typeof detail.first_sent_at).toBe('string');
        expect(typeof detail.veto_deadline_at).toBe('string');

        // Second run: the batch no longer matches the scan
        // (`veto_deadline_at` is set) — a quiet no-op, no second step.
        const second = await anchorVetoDeadlines(sql(), 50);
        expect(second).toEqual({ handled: 0, failed: 0 });
        expect(await readVetoWindowGrantedSteps(parentRunId)).toHaveLength(1);
      });

      it('never anchors a halted batch even when a notice send lands later', async () => {
        const { batchId } = await seedBatch();
        const parentRunId = await seedSendParent(batchId);
        await markAutoApproved(batchId);
        await seedBatchApprovedStep(parentRunId, 60);
        await haltBatch(batchId);
        // The notice provider-accepts AFTER the halt.
        await seedVetoNoticeDelivery(batchId, { sentAgo: '1 minute' });

        const tally = await anchorVetoDeadlines(sql(), 50);
        expect(tally).toEqual({ handled: 0, failed: 0 });

        expect((await readBatchRow(batchId)).veto_deadline_at).toBeNull();
        expect(await readVetoWindowGrantedSteps(parentRunId)).toHaveLength(0);
      });

      it('records the granted window from the policy row at approval and ignores later policy edits', async () => {
        const { batchId } = await seedBatch();
        const parentRunId = await seedSendParent(batchId);
        await markAutoApproved(batchId);
        // The window captured AT APPROVAL — the suite's default seeded
        // policy row grants 60.
        await seedBatchApprovedStep(parentRunId, 60);
        // A later edit to the live policy row — the anchor must ignore it.
        await sql()`
          UPDATE auto_approval_policies
          SET veto_window_minutes = 30
          WHERE account_id = ${accountId()}::uuid
            AND persona = 'solicitation' AND action_class = 'sending'
        `;
        await seedVetoNoticeDelivery(batchId, { sentAgo: '5 minutes' });

        const tally = await anchorVetoDeadlines(sql(), 50);
        expect(tally).toEqual({ handled: 1, failed: 0 });
        expect(await vetoDeadlineMatchesFirstSentPlusWindow(batchId, 60)).toBe(true);

        const steps = await readVetoWindowGrantedSteps(parentRunId);
        expect(parseJsonb(steps[0]!.detail)).toMatchObject({ granted_window_minutes: 60 });
      });

      it('one corrupt anchor candidate does not prevent a healthy sibling batch from anchoring', async () => {
        // Corrupt: auto_policy, unanchored, notice sent — but its
        // batch_approved step is stripped (never seeded), so anchorOneBatch's
        // read of the granted window finds nothing and throws — isolated to
        // this one candidate.
        const corrupt = await seedBatch();
        const corruptParentRunId = await seedSendParent(corrupt.batchId);
        await markAutoApproved(corrupt.batchId);
        await seedVetoNoticeDelivery(corrupt.batchId, { sentAgo: '5 minutes' });

        // The healthy sibling MUST live on a DIFFERENT business: migration
        // 091's `solicitation_batches_one_active_send_per_business` index
        // admits only ONE approved/unhalted/unclosed batch per business at a
        // time, so two simultaneously-approved batches cannot coexist on
        // `businessId` — a second location is the only way to express "an
        // unrelated healthy batch", not a test-only workaround. Scoped and
        // torn down entirely inside this one test.
        const siblingBusinessId = randomUUID();
        await sql()`
          INSERT INTO businesses (
            id, name, owner_name, owner_email, account_id, subscription_status, category
          ) VALUES (
            ${siblingBusinessId}::uuid, 'Auto Approval Sibling Business', 'Auto Owner',
            'sibling-owner@example.test', ${accountId()}::uuid, 'active', 'retail'
          )
        `;
        const siblingUploadId = await seedContactCsvUpload(sql(), {
          accountId: accountId(),
          businessId: siblingBusinessId,
          attestedByUserId: userId(),
          filenamePrefix: 'auto-approval-sibling',
          attestationVersion: 'auto-approval-test',
        });
        const healthyBatchId = randomUUID();
        await sql()`
          INSERT INTO solicitation_batches (
            id, account_id, business_id, source_upload_id, created_at, built_at,
            approved_at, approval_method
          ) VALUES (
            ${healthyBatchId}::uuid, ${accountId()}::uuid, ${siblingBusinessId}::uuid,
            ${siblingUploadId}::uuid, NOW() - INTERVAL '40 days', NOW() - INTERVAL '1 hour',
            NOW() - INTERVAL '5 minutes', 'auto_policy'
          )
        `;
        const healthyParentRunId = randomUUID();
        await sql()`
          INSERT INTO agent_runs (
            id, account_id, business_id, kind, subject_type, subject_id,
            status, started_at, correlation_id
          ) VALUES (
            ${healthyParentRunId}::uuid, ${accountId()}::uuid, ${siblingBusinessId}::uuid,
            'solicitation_send_batch', 'solicitation_batch', ${healthyBatchId},
            'running', NOW() - INTERVAL '1 minute', 'auto-approval-integration-sibling'
          )
        `;
        await seedBatchApprovedStep(healthyParentRunId, 60);
        await sql()`
          INSERT INTO notification_deliveries (
            id, business_id, account_id, entity_id, channel, recipient, template, sent_at
          ) VALUES (
            ${randomUUID()}::uuid, ${siblingBusinessId}::uuid, ${accountId()}::uuid,
            ${healthyBatchId}::uuid, 'email', 'sibling-notice@example.test',
            'solicitation_veto_notice', NOW() - INTERVAL '5 minutes'
          )
        `;

        const tally = await anchorVetoDeadlines(sql(), 50);
        expect(tally).toEqual({ handled: 1, failed: 1 });

        expect((await readBatchRow(corrupt.batchId)).veto_deadline_at).toBeNull();
        const [healthyRow] = await sql()<{ veto_deadline_at: string | null }[]>`
          SELECT veto_deadline_at::text AS veto_deadline_at FROM solicitation_batches
          WHERE id = ${healthyBatchId}::uuid AND account_id = ${accountId()}::uuid
            AND business_id = ${siblingBusinessId}::uuid
        `;
        expect(healthyRow?.veto_deadline_at).not.toBeNull();
        expect(await readVetoWindowGrantedSteps(corruptParentRunId)).toHaveLength(0);
        expect(await readVetoWindowGrantedSteps(healthyParentRunId)).toHaveLength(1);

        // Local cleanup — this sibling business/batch/run/delivery are
        // scoped to THIS test only; the shared afterEach only knows about
        // `businessId`.
        await sql()`DELETE FROM notification_deliveries WHERE business_id = ${siblingBusinessId}::uuid`;
        await sql()`DELETE FROM agent_run_steps WHERE agent_run_id = ${healthyParentRunId}::uuid`;
        await sql()`DELETE FROM agent_runs WHERE id = ${healthyParentRunId}::uuid`;
        await sql()`DELETE FROM solicitation_batches WHERE id = ${healthyBatchId}::uuid`;
        await sql()`DELETE FROM contact_csv_uploads WHERE id = ${siblingUploadId}::uuid`;
        await sql()`DELETE FROM businesses WHERE id = ${siblingBusinessId}::uuid`;
      });

      it('a wrong-template or different-batch delivery row never anchors', async () => {
        const { batchId } = await seedBatch();
        const parentRunId = await seedSendParent(batchId);
        await markAutoApproved(batchId);
        await seedBatchApprovedStep(parentRunId, 60);
        // Wrong template — never matches the EXISTS predicate.
        await seedVetoNoticeDelivery(batchId, {
          template: 'pending_post_notice',
          sentAgo: '5 minutes',
        });
        // A delivery scoped to a DIFFERENT (non-existent) batch id — never
        // matches THIS batch's scan.
        await seedVetoNoticeDelivery(randomUUID(), { sentAgo: '5 minutes' });
        // Provider-accepted then BOUNCED (adversarial R1 finding 2): sent_at
        // set AND failed_at set. Acceptance alone is not evidence the owner
        // was told — a bounced delivery must never start the veto clock, so
        // the right template on the right batch still never anchors.
        await seedVetoNoticeDelivery(batchId, {
          sentAgo: '5 minutes',
          failedAgo: '4 minutes',
        });

        const tally = await anchorVetoDeadlines(sql(), 50);
        expect(tally).toEqual({ handled: 0, failed: 0 });
        expect((await readBatchRow(batchId)).veto_deadline_at).toBeNull();
        expect(await readVetoWindowGrantedSteps(parentRunId)).toHaveLength(0);
      });
    });
  },
);
