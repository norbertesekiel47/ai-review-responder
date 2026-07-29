import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
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
  MIGRATION_088_SOLICITATION_BATCH_EXECUTOR,
  MIGRATION_091_SEND_MODE_SPINE_LIFECYCLE,
} from '@/lib/shared/__tests__/helpers/schema-ready';
import {
  cleanupTenantAccount,
  seedTenantAccount,
  type TenantSeed,
} from '@/lib/shared/__tests__/live-db-tenant';
import { closeBatchIfSettled, type CloseBatchIfSettledResult } from '../outreach';

// Live-DB suite for the send-batch join (#624 T5). Applies NO migration SQL:
// `pnpm test:db:setup` provisions the schema and this file asserts it with
// assertSchemaReady (#573). It holds the cross-process live-DB lock because the
// concurrency case depends on two of its OWN transactions contending on one
// batch row — an unrelated writer in another vitest process would make that
// interleaving unreadable.
//
// Every lifecycle timestamp is written as a SQL interval off NOW(), never as a
// JS `Date`: postgres.js truncates timestamptz microseconds, so a JS-derived
// `built_at` can land before the NOW()-defaulted `created_at` it must not
// precede and trip a constraint that has nothing to do with the case under test.

const testDatabaseUrl = resolveTestDatabaseUrl();
const businessId = randomUUID();

let db: postgresType.Sql | undefined;
let featureDatabaseLock: LiveDbLock | undefined;
let tenant: TenantSeed | undefined;

function sql(): postgresType.Sql {
  if (!db) throw new Error('outreach-close integration database was not initialized');
  return db;
}

function accountId(): string {
  if (!tenant) throw new Error('outreach-close integration tenant was not seeded');
  return tenant.accountId;
}

async function seedUpload(): Promise<string> {
  const uploadId = randomUUID();
  await sql()`
    INSERT INTO contact_csv_uploads (
      id, account_id, business_id, filename, byte_size, content_sha256,
      raw_csv, status, report, attested_by_user_id, attested_at,
      attestation_version, completed_at
    ) VALUES (
      ${uploadId}::uuid, ${accountId()}::uuid, ${businessId}::uuid,
      ${`outreach-close-${uploadId}.csv`}, 1,
      ${uploadId.replaceAll('-', '').padEnd(64, '0').slice(0, 64)},
      NULL, 'completed', ${sql().json({ accepted: 1 })},
      ${tenant!.userId}::uuid, NOW(), 'outreach-close-test', NOW()
    )
  `;
  return uploadId;
}

async function seedContact(uploadId: string): Promise<string> {
  const contactId = randomUUID();
  await sql()`
    INSERT INTO solicitation_contacts (
      id, business_id, name, email, created_by_upload_id
    ) VALUES (
      ${contactId}::uuid, ${businessId}::uuid, 'Outreach Close Candidate',
      ${`${contactId}@example.test`}, ${uploadId}::uuid
    )
  `;
  return contactId;
}

interface BatchInput {
  /** Interval strings off NOW(), e.g. '1 hour' / '8 days'. NULL when omitted. */
  builtAgo?: string;
  approvedAgo?: string;
  approvalMethod?: 'owner' | 'auto_policy';
  sendingStartedAgo?: string;
  sendClosedAgo?: string;
  haltedAgo?: string;
  haltReason?:
    | 'owner_veto'
    | 'owner_halt'
    | 'admin_halt'
    | 'send_window_elapsed'
    | 'batch_expired';
}

interface SeededBatch {
  batchId: string;
  uploadId: string;
}

/**
 * One batch under the seeded business, carrying only the lifecycle columns the
 * case is about. `created_at` is anchored 40 days back so any `built_at` a case
 * needs still satisfies `solicitation_batches_built_after_created`.
 */
async function seedBatch(input: BatchInput = {}): Promise<SeededBatch> {
  const uploadId = await seedUpload();
  const batchId = randomUUID();
  const haltedBy =
    input.haltReason === 'owner_veto'
    || input.haltReason === 'owner_halt'
    || input.haltReason === 'admin_halt'
      ? tenant!.userId
      : null;
  await sql()`
    INSERT INTO solicitation_batches (
      id, account_id, business_id, source_upload_id, created_at,
      built_at, approved_at, approval_method, approved_by_user_id,
      sending_started_at, send_closed_at, halted_at, halt_reason, halted_by
    ) VALUES (
      ${batchId}::uuid, ${accountId()}::uuid, ${businessId}::uuid,
      ${uploadId}::uuid, NOW() - INTERVAL '40 days',
      NOW() - ${input.builtAgo ?? null}::interval,
      NOW() - ${input.approvedAgo ?? null}::interval,
      ${input.approvalMethod ?? null},
      ${input.approvalMethod === 'owner' ? tenant!.userId : null}::uuid,
      NOW() - ${input.sendingStartedAgo ?? null}::interval,
      NOW() - ${input.sendClosedAgo ?? null}::interval,
      NOW() - ${input.haltedAgo ?? null}::interval,
      ${input.haltReason ?? null}, ${haltedBy}::uuid
    )
  `;
  return { batchId, uploadId };
}

interface SendParentInput {
  batchId: string;
  status?: 'running' | 'completed' | 'cancelled' | 'failed';
  errorCode?: 'gate_closed' | 'generation_failed' | 'build_failed';
}

async function seedSendParent(input: SendParentInput): Promise<string> {
  const runId = randomUUID();
  const status = input.status ?? 'running';
  await sql()`
    INSERT INTO agent_runs (
      id, account_id, business_id, kind, subject_type, subject_id,
      status, started_at, ended_at, error, correlation_id
    ) VALUES (
      ${runId}::uuid, ${accountId()}::uuid, ${businessId}::uuid,
      'solicitation_send_batch', 'solicitation_batch', ${input.batchId},
      ${status}, NOW() - INTERVAL '1 minute',
      ${status === 'running' ? null : new Date()},
      ${input.errorCode ? sql().json({ code: input.errorCode }) : null},
      'outreach-close-integration'
    )
  `;
  return runId;
}

async function seedAsk(batchId: string, uploadId: string): Promise<string> {
  const contactId = await seedContact(uploadId);
  const askId = randomUUID();
  await sql()`
    INSERT INTO solicitation_asks (
      id, account_id, business_id, batch_id, contact_id, status,
      withheld_reason, evidence, decided_at
    ) VALUES (
      ${askId}::uuid, ${accountId()}::uuid, ${businessId}::uuid,
      ${batchId}::uuid, ${contactId}::uuid, 'send', NULL,
      ${sql().json({
        contact_id: contactId,
        policy_version: 'outreach-close-fixture',
        decision: 'send',
      })},
      NOW()
    )
  `;
  return askId;
}

interface OutreachInput {
  batchId: string;
  uploadId: string;
  deliveryStatus:
    | 'rendered'
    | 'queued'
    | 'sending'
    | 'sent'
    | 'withheld'
    | 'cancelled'
    | 'failed'
    | 'unknown';
  dispositionReason?: string | null;
}

/** One Outreach row on its own ask — the live-attempt index is per-ask. */
async function seedOutreach(input: OutreachInput): Promise<string> {
  const outreachId = randomUUID();
  const askId = await seedAsk(input.batchId, input.uploadId);
  const [ask] = await sql()<{ contact_id: string }[]>`
    SELECT contact_id::text AS contact_id
    FROM solicitation_asks
    WHERE id = ${askId}::uuid
      AND account_id = ${accountId()}::uuid
      AND business_id = ${businessId}::uuid
  `;
  const withheld = input.deliveryStatus === 'withheld';
  await sql()`
    INSERT INTO solicitation_outreach (
      id, account_id, business_id, batch_id, ask_id, contact_id,
      attempt_no, rendered_subject, rendered_body,
      prompt_version, prompt_hash, interpolation_inputs, rendered_at,
      ask_lint_version, lint_detail, moderation_status, moderation_detail,
      delivery_status, disposition_reason, sent_at
    ) VALUES (
      ${outreachId}::uuid, ${accountId()}::uuid, ${businessId}::uuid,
      ${input.batchId}::uuid, ${askId}::uuid, ${ask!.contact_id}::uuid,
      1,
      ${withheld ? null : 'How did we do?'},
      ${withheld ? null : 'Would you mind leaving a review?'},
      'solicitation_ask_v1', ${outreachId.replaceAll('-', '').padEnd(64, '0').slice(0, 64)},
      ${sql().json({})}, NOW(), 'ask_lint_v1', ${sql().json({})},
      'clean', ${sql().json({})},
      ${input.deliveryStatus}, ${input.dispositionReason ?? null},
      ${input.deliveryStatus === 'sent' ? new Date() : null}
    )
  `;
  return outreachId;
}

function close(batchId: string): Promise<CloseBatchIfSettledResult> {
  return sql().begin((tx) =>
    closeBatchIfSettled(tx, { batchId, accountId: accountId(), businessId }),
  ) as Promise<CloseBatchIfSettledResult>;
}

async function readBatchClosure(batchId: string): Promise<{ send_closed_at: string | null }> {
  const [row] = await sql()<{ send_closed_at: string | null }[]>`
    SELECT send_closed_at::text AS send_closed_at
    FROM solicitation_batches
    WHERE id = ${batchId}::uuid
      AND account_id = ${accountId()}::uuid
      AND business_id = ${businessId}::uuid
  `;
  return row!;
}

async function readRunStatus(runId: string): Promise<string> {
  const [row] = await sql()<{ status: string }[]>`
    SELECT status FROM agent_runs
    WHERE id = ${runId}::uuid
      AND account_id = ${accountId()}::uuid
      AND business_id = ${businessId}::uuid
  `;
  return row!.status;
}

interface CloseStepRow {
  attributed_agent: string;
  detail: unknown;
}

async function readCloseSteps(runId: string): Promise<CloseStepRow[]> {
  return sql()<CloseStepRow[]>`
    SELECT attributed_agent, detail
    FROM agent_run_steps
    WHERE agent_run_id = ${runId}::uuid
      AND step_key = 'send_batch_closed'
    ORDER BY step_index
  `;
}

/** Postgres.js behind PgBouncer can hand back JSONB as a string. */
function stepDetail(row: CloseStepRow): Record<string, unknown> {
  const parsed: unknown =
    typeof row.detail === 'string' ? JSON.parse(row.detail) : row.detail;
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('send_batch_closed step detail is not an object');
  }
  return parsed as Record<string, unknown>;
}

describeWithDb(
  'closeBatchIfSettled against live local Postgres',
  { enabled: Boolean(testDatabaseUrl), timeout: 90_000 },
  () => {
    beforeAll(async () => {
      const databaseUrl = assertLocalTestDatabaseUrl(testDatabaseUrl);
      featureDatabaseLock = await acquireLiveDbLock(databaseUrl);
      db = postgres(databaseUrl, { max: 4, prepare: false });
      await assertSchemaReady(db, [
        MIGRATION_088_SOLICITATION_BATCH_EXECUTOR,
        MIGRATION_091_SEND_MODE_SPINE_LIFECYCLE,
      ]);
      tenant = await seedTenantAccount(db, {
        userName: 'Outreach Close Owner',
        accountDisplayName: 'Outreach Close Account',
      });
      await db`
        INSERT INTO businesses (
          id, name, owner_name, owner_email, account_id,
          subscription_status, category
        ) VALUES (
          ${businessId}::uuid, 'Outreach Close Business', 'Close Owner',
          ${tenant.ownerEmail}, ${tenant.accountId}::uuid, 'active', 'automotive'
        )
      `;
    }, LIVE_DB_LOCK_HOOK_TIMEOUT_MS);

    afterEach(async () => {
      await sql()`DELETE FROM solicitation_outreach WHERE business_id = ${businessId}::uuid`;
      await sql()`DELETE FROM solicitation_asks WHERE business_id = ${businessId}::uuid`;
      await sql()`DELETE FROM solicitation_batches WHERE business_id = ${businessId}::uuid`;
      await sql()`DELETE FROM solicitation_contacts WHERE business_id = ${businessId}::uuid`;
      await sql()`DELETE FROM contact_csv_uploads WHERE business_id = ${businessId}::uuid`;
      await sql()`
        DELETE FROM agent_runs
        WHERE account_id = ${accountId()}::uuid
          AND business_id = ${businessId}::uuid
      `;
    }, 30_000);

    afterAll(async () => {
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

    it('closeBatchIfSettled returns without mutation when the batch has no send parent run', async () => {
      // Zero outreach rows: `NOT EXISTS` is vacuously true here, so only the
      // send-parent guard stands between this batch and a bogus closure.
      const { batchId } = await seedBatch({ builtAgo: '1 hour' });

      const result = await close(batchId);

      expect(result).toEqual({ status: 'no_send_parent' });
      expect((await readBatchClosure(batchId)).send_closed_at).toBeNull();
      const [steps] = await sql()<{ count: number }[]>`
        SELECT COUNT(*)::int AS count FROM agent_run_steps
        WHERE step_key = 'send_batch_closed'
      `;
      expect(steps!.count).toBe(0);
    });

    it('closeBatchIfSettled leaves the parent running while an outreach row is rendered, queued, or sending', async () => {
      for (const liveStatus of ['rendered', 'queued', 'sending'] as const) {
        const { batchId, uploadId } = await seedBatch({
          builtAgo: '2 hours',
          approvedAgo: '1 hour',
          approvalMethod: 'auto_policy',
        });
        const parentRunId = await seedSendParent({ batchId });
        await seedOutreach({ batchId, uploadId, deliveryStatus: 'sent' });
        await seedOutreach({ batchId, uploadId, deliveryStatus: liveStatus });

        const result = await close(batchId);

        expect(result).toEqual({ status: 'not_settled', liveCount: 1 });
        expect((await readBatchClosure(batchId)).send_closed_at).toBeNull();
        expect(await readRunStatus(parentRunId)).toBe('running');
        expect(await readCloseSteps(parentRunId)).toHaveLength(0);

        await sql()`DELETE FROM solicitation_outreach WHERE batch_id = ${batchId}::uuid`;
        await sql()`DELETE FROM solicitation_asks WHERE batch_id = ${batchId}::uuid`;
        await sql()`DELETE FROM solicitation_batches WHERE id = ${batchId}::uuid`;
      }
    });

    it('closeBatchIfSettled maps the exhausted disposition to a completed parent run', async () => {
      const { batchId, uploadId } = await seedBatch({
        builtAgo: '2 hours',
        approvedAgo: '1 hour',
        approvalMethod: 'auto_policy',
        sendingStartedAgo: '30 minutes',
      });
      const parentRunId = await seedSendParent({ batchId });
      await seedOutreach({ batchId, uploadId, deliveryStatus: 'sent' });
      await seedOutreach({ batchId, uploadId, deliveryStatus: 'sent' });
      await seedOutreach({
        batchId,
        uploadId,
        deliveryStatus: 'withheld',
        dispositionReason: 'suppressed',
      });
      await seedOutreach({
        batchId,
        uploadId,
        deliveryStatus: 'withheld',
        dispositionReason: 'unsubscribed',
      });
      await seedOutreach({
        batchId,
        uploadId,
        deliveryStatus: 'failed',
        dispositionReason: 'send_failed',
      });
      await seedOutreach({
        batchId,
        uploadId,
        deliveryStatus: 'unknown',
        dispositionReason: 'send_indeterminate',
      });

      const result = await close(batchId);

      expect(result).toMatchObject({
        status: 'closed',
        parentRunId,
        disposition: 'exhausted',
        parentStatus: 'completed',
        counts: {
          sent: 2,
          withheld: 2,
          cancelled: 0,
          failed: 1,
          unknown: 1,
        },
      });
      expect(await readRunStatus(parentRunId)).toBe('completed');
      expect((await readBatchClosure(batchId)).send_closed_at).not.toBeNull();

      const steps = await readCloseSteps(parentRunId);
      expect(steps).toHaveLength(1);
      expect(steps[0]!.attributed_agent).toBe('solicitation');
      expect(stepDetail(steps[0]!)).toEqual({
        disposition: 'exhausted',
        sent: 2,
        withheld: 2,
        cancelled: 0,
        failed: 1,
        unknown: 1,
        withheld_by_reason: { suppressed: 1, unsubscribed: 1 },
      });
    });

    it('closeBatchIfSettled maps the halted disposition to a cancelled parent run', async () => {
      const { batchId, uploadId } = await seedBatch({
        builtAgo: '2 hours',
        approvedAgo: '1 hour',
        approvalMethod: 'auto_policy',
        sendingStartedAgo: '30 minutes',
        haltedAgo: '5 minutes',
        haltReason: 'owner_halt',
      });
      const parentRunId = await seedSendParent({ batchId });
      await seedOutreach({ batchId, uploadId, deliveryStatus: 'sent' });
      await seedOutreach({
        batchId,
        uploadId,
        deliveryStatus: 'cancelled',
        dispositionReason: 'owner_halt',
      });

      const result = await close(batchId);

      expect(result).toMatchObject({
        status: 'closed',
        disposition: 'halted',
        parentStatus: 'cancelled',
      });
      expect(await readRunStatus(parentRunId)).toBe('cancelled');
      expect(stepDetail((await readCloseSteps(parentRunId))[0]!)).toMatchObject({
        disposition: 'halted',
        sent: 1,
        cancelled: 1,
      });
    });

    it('closeBatchIfSettled maps the expired disposition to a cancelled parent run', async () => {
      // Built 8 days ago and never approved: past the 7-day approval window.
      const { batchId, uploadId } = await seedBatch({ builtAgo: '8 days' });
      const parentRunId = await seedSendParent({ batchId });
      await seedOutreach({
        batchId,
        uploadId,
        deliveryStatus: 'cancelled',
        dispositionReason: 'batch_expired',
      });

      const result = await close(batchId);

      expect(result).toMatchObject({
        status: 'closed',
        disposition: 'expired',
        parentStatus: 'cancelled',
      });
      expect(await readRunStatus(parentRunId)).toBe('cancelled');
    });

    it('closeBatchIfSettled maps the generation_failed disposition to a failed parent run', async () => {
      // The realistic ordering: the generation lane records the failure on the
      // parent, then joins in the SAME transaction. The terminal transition
      // no-ops; the disposition still has to come out right.
      const { batchId, uploadId } = await seedBatch({ builtAgo: '2 hours' });
      const parentRunId = await seedSendParent({
        batchId,
        status: 'failed',
        errorCode: 'generation_failed',
      });
      await seedOutreach({
        batchId,
        uploadId,
        deliveryStatus: 'withheld',
        dispositionReason: 'render_failed',
      });

      const result = await close(batchId);

      expect(result).toMatchObject({
        status: 'closed',
        disposition: 'generation_failed',
        parentStatus: 'failed',
      });
      expect(await readRunStatus(parentRunId)).toBe('failed');
      expect(stepDetail((await readCloseSteps(parentRunId))[0]!)).toMatchObject({
        disposition: 'generation_failed',
        withheld: 1,
        withheld_by_reason: { render_failed: 1 },
      });
    });

    it('closeBatchIfSettled maps the gate_closed disposition to a failed parent run', async () => {
      // Deliberately the OTHER ordering: the recorded failure is read from a
      // parent that is still running, so this case proves the mapping actually
      // WRITES 'failed' rather than inheriting it.
      const { batchId, uploadId } = await seedBatch({ builtAgo: '2 hours' });
      const parentRunId = await seedSendParent({ batchId, errorCode: 'gate_closed' });
      await seedOutreach({
        batchId,
        uploadId,
        deliveryStatus: 'cancelled',
        dispositionReason: 'superseded',
      });

      const result = await close(batchId);

      expect(result).toMatchObject({
        status: 'closed',
        disposition: 'gate_closed',
        parentStatus: 'failed',
      });
      expect(await readRunStatus(parentRunId)).toBe('failed');
    });

    it('closeBatchIfSettled prefers halted over every other disposition source', async () => {
      // Over-determined on purpose: halted AND past the approval window AND
      // carrying a recorded gate_closed failure. Every lower source fires, so
      // only the precedence can produce the right answer.
      const { batchId, uploadId } = await seedBatch({
        builtAgo: '9 days',
        haltedAgo: '1 hour',
        haltReason: 'batch_expired',
      });
      const parentRunId = await seedSendParent({ batchId, errorCode: 'gate_closed' });
      await seedOutreach({
        batchId,
        uploadId,
        deliveryStatus: 'cancelled',
        dispositionReason: 'batch_expired',
      });

      const result = await close(batchId);

      expect(result).toMatchObject({
        status: 'closed',
        disposition: 'halted',
        parentStatus: 'cancelled',
      });
      expect(await readRunStatus(parentRunId)).toBe('cancelled');
    });

    it('closeBatchIfSettled appends no second step when the batch is already closed', async () => {
      const { batchId, uploadId } = await seedBatch({
        builtAgo: '2 hours',
        approvedAgo: '1 hour',
        approvalMethod: 'auto_policy',
      });
      const parentRunId = await seedSendParent({ batchId });
      await seedOutreach({ batchId, uploadId, deliveryStatus: 'sent' });

      const first = await close(batchId);
      const second = await close(batchId);

      expect(first).toMatchObject({ status: 'closed' });
      expect(second).toEqual({ status: 'already_closed' });
      expect(await readCloseSteps(parentRunId)).toHaveLength(1);
      expect(await readRunStatus(parentRunId)).toBe('completed');
    });

    it('closeBatchIfSettled terminalizes the parent exactly once under concurrent child terminals', async () => {
      const { batchId, uploadId } = await seedBatch({
        builtAgo: '2 hours',
        approvedAgo: '1 hour',
        approvalMethod: 'auto_policy',
        sendingStartedAgo: '30 minutes',
      });
      const parentRunId = await seedSendParent({ batchId });
      const firstOutreachId = await seedOutreach({
        batchId,
        uploadId,
        deliveryStatus: 'sending',
      });
      const secondOutreachId = await seedOutreach({
        batchId,
        uploadId,
        deliveryStatus: 'sending',
      });

      // Each child does what the send worker's terminal tx does: CAS its own row
      // to a terminal status, then join — in ONE transaction.
      const terminalize = (outreachId: string): Promise<CloseBatchIfSettledResult> =>
        sql().begin(async (tx) => {
          await tx`
            UPDATE solicitation_outreach
            SET delivery_status = 'sent', sent_at = NOW(), updated_at = NOW()
            WHERE id = ${outreachId}::uuid
              AND account_id = ${accountId()}::uuid
              AND business_id = ${businessId}::uuid
              AND delivery_status = 'sending'
          `;
          return closeBatchIfSettled(tx, {
            batchId,
            accountId: accountId(),
            businessId,
          });
        }) as Promise<CloseBatchIfSettledResult>;

      const results = await Promise.all([
        terminalize(firstOutreachId),
        terminalize(secondOutreachId),
      ]);

      expect(results.filter((result) => result.status === 'closed')).toHaveLength(1);
      expect(await readCloseSteps(parentRunId)).toHaveLength(1);
      expect(await readRunStatus(parentRunId)).toBe('completed');
      expect((await readBatchClosure(batchId)).send_closed_at).not.toBeNull();
    });
  },
);
