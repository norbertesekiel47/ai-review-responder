import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
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
  MIGRATION_092_TERMINAL_OUTREACH_BODY_REDACTION,
} from '@/lib/shared/__tests__/helpers/schema-ready';
import {
  cleanupTenantAccount,
  seedTenantAccount,
  type TenantSeed,
} from '@/lib/shared/__tests__/live-db-tenant';
import { checksum } from '@/lib/shared/__tests__/helpers/outreach-fixture';

// The §7.4 idempotency claim executed against the real schema: the probe, the
// render inserts, the send-parent run, the generation steps, and the outbox
// completion CAS all run unmocked. Only the SPEND boundary is faked — a
// counting reserveCost and a canned LLM completion — because reservations are
// exactly what the test measures. Applies NO migration SQL (#573):
// `pnpm test:db:setup` provisions to head; assertSchemaReady asserts it.
//
// NOTE (#627 inert-landing): businesses.solicitation_postal_address does not
// exist at head 092, so the context loader's to_jsonb projection reads NULL
// and the freshly generated child withholds lint_failed /
// missing_required_element — asserted below as the fail-closed postal path.

const llmMocks = vi.hoisted(() => ({ runLlmTask: vi.fn() }));
const costMocks = vi.hoisted(() => ({
  reserveCost: vi.fn(),
  finalizeCost: vi.fn(),
  releaseCost: vi.fn(),
}));

vi.mock('@/lib/llm/run-task', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/llm/run-task')>()),
  runLlmTask: llmMocks.runLlmTask,
}));
vi.mock('@/lib/costs/tracker', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/costs/tracker')>()),
  reserveCost: costMocks.reserveCost,
  finalizeCost: costMocks.finalizeCost,
  releaseCost: costMocks.releaseCost,
}));

import { OPENAI_MODEL } from '@/lib/llm/tasks';
import { SOLICITATION_ASK_PROMPT_VERSION, solicitationAskPromptHash } from '../ask-prompt-policy';
import { ASK_LINT_VERSION } from '../ask-compliance-lint';
import { insertOutreachRender } from '../outreach';
import { generateAsksForBatch } from '../ask-generation';

const testDatabaseUrl = resolveTestDatabaseUrl();

const businessId = randomUUID();
const uploadId = randomUUID();
const batchId = randomUUID();

let db: postgresType.Sql | undefined;
let featureDatabaseLock: LiveDbLock | undefined;
let tenant: TenantSeed | undefined;
let flagBefore: string | undefined;

function sql(): postgresType.Sql {
  if (!db) throw new Error('ask-generation integration database was not initialized');
  return db;
}

function accountId(): string {
  if (!tenant) throw new Error('ask-generation integration tenant was not seeded');
  return tenant.accountId;
}

/** One send ask on its own contact, with one visit (the §1.1 inputs). */
async function seedSendAsk(n: number): Promise<string> {
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
  return askId;
}

async function contactIdOfAsk(askId: string): Promise<string> {
  const [row] = await sql()<{ contact_id: string }[]>`
    SELECT contact_id::text AS contact_id FROM solicitation_asks
    WHERE id = ${askId}::uuid
      AND account_id = ${accountId()}::uuid
      AND business_id = ${businessId}::uuid
  `;
  return row!.contact_id;
}

/** A prior successful render at the CURRENT prompt version (the skip target). */
async function seedRenderedAttempt(askId: string): Promise<void> {
  const contactId = await contactIdOfAsk(askId);
  await sql().begin(async (tx) => {
    await insertOutreachRender(tx, {
      accountId: accountId(),
      businessId,
      batchId,
      askId,
      contactId,
      attemptNo: 1,
      renderedSubject: 'How was your visit?',
      renderedBody: 'Would you mind leaving us a review?',
      promptVersion: SOLICITATION_ASK_PROMPT_VERSION,
      promptHash: solicitationAskPromptHash(),
      askLintVersion: ASK_LINT_VERSION,
      lintDetail: [],
      moderationStatus: 'clean',
      moderationDetail: {},
      interpolationInputs: {
        contact_first_name: 'Alice',
        business_name: 'Ask Generation Business',
        days_since_visit_bucket: 'a few days ago',
        vertical: 'retail',
        visit_note: null,
        note_disposition: 'absent',
      },
      renderedAt: new Date(),
      agentRunId: null,
      deliveryStatus: 'rendered',
    });
  });
}

async function seedDispatchedOutboxRow(): Promise<{ outboxId: string; attempt: number }> {
  const outboxId = randomUUID();
  await sql()`
    INSERT INTO job_outbox (
      id, topic, aggregate_type, aggregate_id, payload,
      status, attempts, dispatched_at
    ) VALUES (
      ${outboxId}::uuid, 'generate_solicitation_asks', 'solicitation_batch',
      ${batchId}::uuid, ${sql().json({ batch_id: batchId, business_id: businessId })},
      'dispatched', 1, NOW()
    )
  `;
  return { outboxId, attempt: 1 };
}

describeWithDb(
  'ask generation over live local Postgres',
  { enabled: Boolean(testDatabaseUrl), timeout: 60_000 },
  () => {
    beforeAll(async () => {
      const databaseUrl = assertLocalTestDatabaseUrl(testDatabaseUrl);
      featureDatabaseLock = await acquireLiveDbLock(databaseUrl);
      db = postgres(databaseUrl, { max: 2, prepare: false });
      await assertSchemaReady(db, [
        MIGRATION_088_SOLICITATION_BATCH_EXECUTOR,
        MIGRATION_091_SEND_MODE_SPINE_LIFECYCLE,
        MIGRATION_092_TERMINAL_OUTREACH_BODY_REDACTION,
      ]);

      tenant = await seedTenantAccount(db, {
        userName: 'Ask Generation Owner',
        accountDisplayName: 'Ask Generation Account',
      });
      await db`
        INSERT INTO businesses (
          id, name, owner_name, owner_email, account_id, subscription_status, category
        ) VALUES (
          ${businessId}::uuid, 'Ask Generation Business', 'Ask Owner',
          ${tenant.ownerEmail}, ${tenant.accountId}::uuid, 'active', 'retail'
        )
      `;
      await db`
        UPDATE accounts
        SET subscription_status = 'active', subscription_tier = 'copilot'
        WHERE id = ${tenant.accountId}::uuid
      `;
      await db`
        INSERT INTO contact_csv_uploads (
          id, account_id, business_id, filename, byte_size, content_sha256,
          raw_csv, status, report, attested_by_user_id, attested_at,
          attestation_version, completed_at
        ) VALUES (
          ${uploadId}::uuid, ${tenant.accountId}::uuid, ${businessId}::uuid,
          'ask-generation.csv', 1, ${checksum(uploadId)},
          NULL, 'completed', ${db.json({ accepted: 3 })},
          ${tenant.userId}::uuid, NOW(), 'ask-generation-test', NOW()
        )
      `;
      await db`
        INSERT INTO solicitation_batches (id, account_id, business_id, source_upload_id, built_at)
        VALUES (
          ${batchId}::uuid, ${tenant.accountId}::uuid, ${businessId}::uuid,
          ${uploadId}::uuid, NOW()
        )
      `;

      flagBefore = process.env.SOLICITATION_SEND_ENABLED;
      process.env.SOLICITATION_SEND_ENABLED = 'true';
    }, LIVE_DB_LOCK_HOOK_TIMEOUT_MS);

    beforeEach(() => {
      llmMocks.runLlmTask.mockReset();
      costMocks.reserveCost.mockReset();
      costMocks.finalizeCost.mockReset();
      costMocks.releaseCost.mockReset();
      const structured = {
        subject: 'Thanks for visiting Ask Generation Business',
        body: 'Hi Alice, thanks for coming by Ask Generation Business. Would you share how it went?',
      };
      llmMocks.runLlmTask.mockResolvedValue({
        text: JSON.stringify(structured),
        provider: 'openai',
        model: OPENAI_MODEL,
        usage: { promptTokens: 500, completionTokens: 120 },
        structured,
      });
      costMocks.reserveCost.mockResolvedValue('2026-07-31');
      costMocks.finalizeCost.mockResolvedValue(undefined);
      costMocks.releaseCost.mockResolvedValue(undefined);
    });

    afterEach(async () => {
      if (!db) return;
      await db`DELETE FROM solicitation_outreach WHERE business_id = ${businessId}::uuid`;
      await db`DELETE FROM solicitation_asks WHERE business_id = ${businessId}::uuid`;
      await db`DELETE FROM solicitation_contacts WHERE business_id = ${businessId}::uuid`;
      await db`DELETE FROM api_costs WHERE business_id = ${businessId}::uuid`;
      await db`
        DELETE FROM agent_run_steps
        WHERE agent_run_id IN (
          SELECT id FROM agent_runs WHERE business_id = ${businessId}::uuid
        )
      `;
      await db`DELETE FROM agent_runs WHERE business_id = ${businessId}::uuid`;
      await db`DELETE FROM job_outbox WHERE aggregate_id = ${batchId}::uuid`;
      // The shared batch row is reused across tests: restore the built-only
      // lifecycle a settling test (generation_failed close) advanced.
      await db`
        UPDATE solicitation_batches
        SET send_closed_at = NULL
        WHERE id = ${batchId}::uuid
      `;
    });

    afterAll(async () => {
      if (flagBefore === undefined) delete process.env.SOLICITATION_SEND_ENABLED;
      else process.env.SOLICITATION_SEND_ENABLED = flagBefore;
      try {
        if (db) {
          await db`DELETE FROM solicitation_batches WHERE id = ${batchId}::uuid`;
          await db`DELETE FROM contact_csv_uploads WHERE id = ${uploadId}::uuid`;
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

    it('re-running generation over a half-complete batch reserves nothing for rendered asks', async () => {
      const askIds = [await seedSendAsk(1), await seedSendAsk(2), await seedSendAsk(3)];
      await seedRenderedAttempt(askIds[0]!);
      await seedRenderedAttempt(askIds[1]!);
      const handle = await seedDispatchedOutboxRow();

      const result = await generateAsksForBatch(sql(), {
        batchId,
        businessId,
        outboxHandle: handle,
      });

      // The two already-rendered asks were skipped BEFORE the reserve: exactly
      // one reservation, for the one un-generated ask (SPEC §7.4).
      expect(costMocks.reserveCost).toHaveBeenCalledTimes(1);
      expect(llmMocks.runLlmTask).toHaveBeenCalledTimes(1);
      expect(result.skippedExisting).toBe(2);

      // Head is 092: businesses.solicitation_postal_address does not exist yet,
      // so the third child fails CLOSED — withheld lint_failed with
      // missing_required_element and NULL bodies (#622 §7.6), proven against
      // the real 091 constraints.
      expect(result).toMatchObject({ rendered: 0, withheld: 1, failed: 0 });
      const [thirdRow] = await sql()<
        { delivery_status: string; disposition_reason: string | null; rendered_body: string | null }[]
      >`
        SELECT delivery_status, disposition_reason, rendered_body
        FROM solicitation_outreach
        WHERE ask_id = ${askIds[2]!}::uuid
          AND account_id = ${accountId()}::uuid
          AND business_id = ${businessId}::uuid
      `;
      expect(thirdRow).toMatchObject({
        delivery_status: 'withheld',
        disposition_reason: 'lint_failed',
        rendered_body: null,
      });

      // The finale completed the outbox attempt and recorded one generation
      // step per non-cancelled outreach row on the send parent.
      const [outboxRow] = await sql()<{ status: string }[]>`
        SELECT status FROM job_outbox WHERE id = ${handle.outboxId}::uuid
      `;
      expect(outboxRow).toMatchObject({ status: 'completed' });

      const [parent] = await sql()<{ id: string; status: string }[]>`
        SELECT id, status FROM agent_runs
        WHERE kind = 'solicitation_send_batch'
          AND subject_type = 'solicitation_batch'
          AND subject_id = ${batchId}
          AND account_id = ${accountId()}::uuid
          AND business_id = ${businessId}::uuid
      `;
      expect(parent).toBeDefined();
      // Two rendered rows are still live, so the batch did NOT settle and the
      // send parent keeps running (awaiting approval).
      expect(parent!.status).toBe('running');
      const steps = await sql()<{ step_key: string }[]>`
        SELECT step_key FROM agent_run_steps
        WHERE agent_run_id = ${parent!.id}::uuid AND step_key = 'ask_generated'
      `;
      expect(steps).toHaveLength(3);

      // Re-running with a fresh dispatched attempt reserves NOTHING further:
      // the third ask now holds a terminal withheld row, and decision 5 skips
      // terminal rows too.
      costMocks.reserveCost.mockClear();
      llmMocks.runLlmTask.mockClear();
      const secondHandle = await seedDispatchedOutboxRow();
      const rerun = await generateAsksForBatch(sql(), {
        batchId,
        businessId,
        outboxHandle: secondHandle,
      });
      expect(costMocks.reserveCost).not.toHaveBeenCalled();
      expect(llmMocks.runLlmTask).not.toHaveBeenCalled();
      expect(rerun).toMatchObject({ rendered: 0, withheld: 0, failed: 0, skippedExisting: 3 });
    });

    it('terminalizes the send parent failed with generation_failed when every render fails or is withheld', async () => {
      // Two fresh asks, no prior renders. At head 092 the postal-address
      // column is absent, so BOTH freshly generated children withhold
      // lint_failed (fail-closed footer) — zero rows stay releasable, which is
      // exactly D14's "nothing to approve" settle: the finale's k = 0 arm
      // hands closeBatchIfSettled the generation_failed failure.
      await seedSendAsk(1);
      await seedSendAsk(2);
      const handle = await seedDispatchedOutboxRow();

      const result = await generateAsksForBatch(sql(), {
        batchId,
        businessId,
        outboxHandle: handle,
      });
      expect(result).toMatchObject({
        rendered: 0,
        withheld: 2,
        failed: 0,
        skippedExisting: 0,
      });

      // The finale still completed the owned outbox attempt (decision 9).
      const [outboxRow] = await sql()<{ status: string }[]>`
        SELECT status FROM job_outbox WHERE id = ${handle.outboxId}::uuid
      `;
      expect(outboxRow).toMatchObject({ status: 'completed' });

      // The send parent terminalized failed, and the error jsonb carries the
      // generation_failed attribution with the two-count evidence split.
      const [parent] = await sql()<
        { id: string; status: string; error: unknown }[]
      >`
        SELECT id, status, error FROM agent_runs
        WHERE kind = 'solicitation_send_batch'
          AND subject_type = 'solicitation_batch'
          AND subject_id = ${batchId}
          AND account_id = ${accountId()}::uuid
          AND business_id = ${businessId}::uuid
      `;
      expect(parent).toBeDefined();
      expect(parent!.status).toBe('failed');
      const parentError =
        typeof parent!.error === 'string'
          ? (JSON.parse(parent!.error) as Record<string, unknown>)
          : (parent!.error as Record<string, unknown>);
      expect(parentError).toMatchObject({
        code: 'generation_failed',
        failed_count: 0,
        withheld_count: 2,
      });

      // The batch settled: send lane closed with the generation_failed
      // disposition on the close receipt.
      const [batchRow] = await sql()<{ send_closed_at: Date | null }[]>`
        SELECT send_closed_at FROM solicitation_batches
        WHERE id = ${batchId}::uuid
      `;
      expect(batchRow!.send_closed_at).not.toBeNull();
      const [closeStep] = await sql()<{ detail: unknown }[]>`
        SELECT detail FROM agent_run_steps
        WHERE agent_run_id = ${parent!.id}::uuid
          AND step_key = 'send_batch_closed'
      `;
      expect(closeStep).toBeDefined();
      const closeDetail =
        typeof closeStep!.detail === 'string'
          ? (JSON.parse(closeStep!.detail) as Record<string, unknown>)
          : (closeStep!.detail as Record<string, unknown>);
      expect(closeDetail).toMatchObject({
        disposition: 'generation_failed',
        withheld: 2,
      });
    });
  },
);
