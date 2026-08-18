import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
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
  MIGRATION_099_SOLICITATION_POSTAL_ADDRESS,
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
// NOTE (#656): businesses.solicitation_postal_address exists as of migration
// 099 and the context loader reads it DIRECTLY — the #627-era to_jsonb shim is
// gone. The shared business fixture is seeded UNATTESTED, so the column reads
// NULL and freshly generated children withhold lint_failed /
// missing_required_element — the fail-closed postal path asserted below. The
// last test attests the fixture and resets it, proving the direct read returns
// real bytes rather than always-NULL.

const llmMocks = vi.hoisted(() => ({ runLlmTask: vi.fn() }));
const costMocks = vi.hoisted(() => ({
  reserveCost: vi.fn(),
  finalizeCost: vi.fn(),
  releaseCost: vi.fn(),
  // Redis-backed, and this lane stands up Postgres only — the regen budget is
  // asserted in the unit suite and in tracker.test.ts, never here.
  checkAskRegenBudget: vi.fn(),
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
  checkAskRegenBudget: costMocks.checkAskRegenBudget,
}));

import { OPENAI_MODEL } from '@/lib/llm/tasks';
import { SOLICITATION_ASK_PROMPT_VERSION, solicitationAskPromptHash } from '../ask-prompt-policy';
import { ASK_LINT_VERSION } from '../ask-compliance-lint';
import { insertOutreachRender } from '../outreach';
import { approveBatch, type ApproveBatchResult } from '../approval';
import { generateAsksForBatch, regenerateAsk } from '../ask-generation';

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

/**
 * The CAS target every door in this module completes. `regenerateAsk` never
 * reads the topic; it only needs an owned `dispatched` row to complete.
 *
 * `topic` is a raw string, NOT because no constant exists —
 * `QUEUE_NAMES.GENERATE_SOLICITATION_ASKS` does, and the sibling live-DB suite
 * imports it. It is raw because one caller deliberately passes a topic that has
 * no constant and never will: migration 091's
 * `job_outbox_generate_solicitation_asks_inflight` is a partial unique index on
 * `(topic, aggregate_id)` over the in-flight statuses, so seeding a SECOND row
 * for the same batch while the first is still `dispatched` is rejected. A
 * fictitious topic sidesteps that index instead of completing the first row.
 * Acknowledged fixture shortcut: the row it writes does not have the shape
 * production writes, and the shared topic is exactly what makes the per-batch
 * dedup work. (`ci:outbox-topics` skips `__tests__`, so nothing flags it.)
 */
async function seedDispatchedOutboxRow(
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

/** The CONTENT of an ask's live attempt — the bytes ADR 0020 says are final. */
async function readOutreachBytes(
  askId: string,
): Promise<{ subject: string | null; body: string | null }> {
  const [row] = await sql()<{ rendered_subject: string | null; rendered_body: string | null }[]>`
    SELECT rendered_subject, rendered_body
    FROM solicitation_outreach
    WHERE ask_id = ${askId}::uuid
      AND account_id = ${accountId()}::uuid
      AND business_id = ${businessId}::uuid
      AND delivery_status <> 'cancelled'
    ORDER BY attempt_no DESC
    LIMIT 1
  `;
  return { subject: row?.rendered_subject ?? null, body: row?.rendered_body ?? null };
}

/** Every attempt row of the batch, oldest first. */
async function readOutreach(): Promise<
  { attempt_no: number; delivery_status: string; disposition_reason: string | null }[]
> {
  return sql()<
    { attempt_no: number; delivery_status: string; disposition_reason: string | null }[]
  >`
    SELECT attempt_no, delivery_status, disposition_reason
    FROM solicitation_outreach
    WHERE batch_id = ${batchId}::uuid
      AND account_id = ${accountId()}::uuid
      AND business_id = ${businessId}::uuid
    ORDER BY attempt_no
  `;
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
        // Ask generation reads solicitation_postal_address directly once the
        // to_jsonb shim is retired (#656 T7) — a behind-head DB must fail with
        // the setup message, not an undefined-column error.
        MIGRATION_099_SOLICITATION_POSTAL_ADDRESS,
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
      costMocks.checkAskRegenBudget.mockReset();
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
      costMocks.checkAskRegenBudget.mockResolvedValue(undefined);
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

      // The fixture business is UNATTESTED, so its postal address reads NULL
      // and the third child fails CLOSED — withheld lint_failed with
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
      // Two fresh asks, no prior renders. The fixture business is unattested,
      // so the postal address reads NULL and BOTH freshly generated children withhold
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

    // #656 T7 — the to_jsonb shim existed SOLELY because
    // businesses.solicitation_postal_address did not exist; migration 099
    // creates it, so the projection is a direct column read and the shim is
    // DELETED, not left as a fallback.
    //
    // The two tests above only prove the loader yields NULL for an unattested
    // location — which a permanently-broken projection also does. This one is
    // the other half: with the column populated, the loader must surface those
    // exact bytes, and they must reach the assembled footer verbatim.
    it('ask generation reads solicitation_postal_address directly without the to_jsonb shim', async () => {
      const postalAddress = '123 Main St\nAustin, TX 78701';
      // Raw fixture write: this test is about what the READ does with a
      // populated column. The digest is computed server-side from the same
      // bound parameter the column stores, so migration 099's all-or-nothing
      // and digest CHECKs both hold — an address-only UPDATE would be rejected.
      await sql()`
        UPDATE businesses
        SET solicitation_postal_address = ${postalAddress},
            solicitation_postal_address_attested_at = NOW(),
            solicitation_postal_address_attested_by_user_id = ${tenant!.userId}::uuid,
            solicitation_postal_address_attestation_version = 'postal_address_attestation_v1',
            solicitation_postal_address_attested_digest =
              encode(sha256(convert_to(${postalAddress}::text, 'UTF8')), 'hex')
        WHERE id = ${businessId}::uuid
          AND account_id = ${accountId()}::uuid
      `;

      try {
        const askId = await seedSendAsk(1);
        const handle = await seedDispatchedOutboxRow();

        const result = await generateAsksForBatch(sql(), {
          batchId,
          businessId,
          outboxHandle: handle,
        });

        // With the address present the render no longer fails closed: the
        // direct column read returned real bytes, not the shim's NULL.
        expect(result).toMatchObject({ rendered: 1, withheld: 0, failed: 0 });

        const [row] = await sql()<
          { delivery_status: string; disposition_reason: string | null; rendered_body: string | null }[]
        >`
          SELECT delivery_status, disposition_reason, rendered_body
          FROM solicitation_outreach
          WHERE ask_id = ${askId}::uuid
            AND account_id = ${accountId()}::uuid
            AND business_id = ${businessId}::uuid
        `;
        expect(row).toMatchObject({
          delivery_status: 'rendered',
          disposition_reason: null,
        });
        // Verbatim, both lines — the footer bakes the stored bytes in as-is, so
        // a projection that trimmed, folded or re-encoded them would show here.
        expect(row!.rendered_body).toContain(postalAddress);

        // Provenance leg — WITHOUT this the title over-promises. Once migration
        // 099 exists, `to_jsonb(b) ->> 'solicitation_postal_address'` returns
        // BYTE-IDENTICAL output to the direct column read, so every assertion
        // above stays green with the shim reinstated. Behaviour cannot
        // distinguish them; only the source can. (Branch review, standards
        // axis — the same class of gap T5 closed for the attestation label.)
        const loaderSource = await readFile(
          resolve(process.cwd(), 'src/lib/solicitation/ask-generation.ts'),
          'utf-8',
        );
        expect(loaderSource).not.toContain('to_jsonb');
        expect(loaderSource).toContain('b.solicitation_postal_address AS postal_address');
      } finally {
        // Reset the whole tuple so the two fail-closed tests above stay valid
        // in any execution order. All five together — the all-or-nothing CHECK
        // rejects a partial clear.
        await sql()`
          UPDATE businesses
          SET solicitation_postal_address = NULL,
              solicitation_postal_address_attested_at = NULL,
              solicitation_postal_address_attested_by_user_id = NULL,
              solicitation_postal_address_attestation_version = NULL,
              solicitation_postal_address_attested_digest = NULL
          WHERE id = ${businessId}::uuid
            AND account_id = ${accountId()}::uuid
        `;
      }
    });

    // ADR 0020 (#860), codex round-1 finding 2. Every other regeneration test is
    // mocked, which proves JavaScript call order and nothing about Postgres.
    // This one runs the swap transaction against the real database so the
    // claim rests on real row locks and a real ROLLBACK.
    //
    // The race is made deterministic rather than hoped for: `approveBatch` runs
    // INSIDE the LLM mock, which is exactly the window `regenerateAsk` leaves
    // open by design (decision 7 — no transaction spans the LLM call). So the
    // pre-check legitimately reads `built`, approval commits, and the locked
    // re-check under `FOR UPDATE` is the gate that has to refuse. Approving
    // before the call instead would only exercise the pre-check and would leave
    // the rollback path — the half that owns the bytes — untested.
    it('keeps approved outreach bytes unchanged when approval races the real regeneration swap', async () => {
      // Attested address, so the child RENDERS and there are real bytes to
      // compare; the fixture business is unattested by default (see the header).
      const postalAddress = '500 Congress Ave\nAustin, TX 78701';
      await sql()`
        UPDATE businesses
        SET solicitation_postal_address = ${postalAddress},
            solicitation_postal_address_attested_at = NOW(),
            solicitation_postal_address_attested_by_user_id = ${tenant!.userId}::uuid,
            solicitation_postal_address_attestation_version = 'postal_address_attestation_v1',
            solicitation_postal_address_attested_digest =
              encode(sha256(convert_to(${postalAddress}::text, 'UTF8')), 'hex')
        WHERE id = ${businessId}::uuid
          AND account_id = ${accountId()}::uuid
      `;

      try {
        const askId = await seedSendAsk(1);
        const generation = await generateAsksForBatch(sql(), {
          batchId,
          businessId,
          outboxHandle: await seedDispatchedOutboxRow(),
        });
        expect(generation).toMatchObject({ rendered: 1, withheld: 0, failed: 0 });

        const before = await readOutreachBytes(askId);
        expect(before.body).toBeTruthy();

        // The replacement the swap would install if it were allowed to. Its
        // bytes differ from the approved ones, so a swap that DID commit could
        // not pass the equality assertion below by accident.
        const replacement = {
          subject: 'A different subject the owner never approved',
          body: 'Hi Alice, a completely different body the owner never approved.',
        };
        let approval: ApproveBatchResult | undefined;
        llmMocks.runLlmTask.mockImplementationOnce(async () => {
          approval = await approveBatch(sql(), {
            batchId,
            accountId: accountId(),
            businessId,
            approvedByUserId: tenant!.userId,
            excludedOutreachIds: [],
          });
          return {
            text: JSON.stringify(replacement),
            provider: 'openai',
            model: OPENAI_MODEL,
            usage: { promptTokens: 500, completionTokens: 120 },
            structured: replacement,
          };
        });

        await regenerateAsk(sql(), {
          batchId,
          businessId,
          askId,
          outboxHandle: await seedDispatchedOutboxRow('regenerate_solicitation_ask'),
          correlationId: 'test-byte-finality',
        });

        expect(approval).toMatchObject({ status: 'approved', approvedCount: 1 });

        // The assertion that matters is on BYTES, not on call counts: subject
        // and body are identical, attempt_no did not advance, and no superseded
        // row appeared. A mocked test cannot make this claim.
        expect(await readOutreachBytes(askId)).toEqual(before);
        const rows = await readOutreach();
        expect(rows).toHaveLength(1);
        expect(rows[0]!.attempt_no).toBe(1);
        expect(rows[0]!.delivery_status).toBe('rendered');
        expect(rows.some((row) => row.disposition_reason === 'superseded')).toBe(false);
      } finally {
        // The batch row and the business row are BOTH shared across this
        // suite's tests, and afterEach clears neither of these columns —
        // leaving them set would make every later test order-dependent (and
        // 091's one-active-send-per-business partial index would hold the slot).
        await sql()`
          UPDATE solicitation_batches
          SET approved_at = NULL,
              approval_method = NULL,
              approved_by_user_id = NULL,
              veto_deadline_at = NULL
          WHERE id = ${batchId}::uuid
            AND account_id = ${accountId()}::uuid
            AND business_id = ${businessId}::uuid
        `;
        await sql()`
          UPDATE businesses
          SET solicitation_postal_address = NULL,
              solicitation_postal_address_attested_at = NULL,
              solicitation_postal_address_attested_by_user_id = NULL,
              solicitation_postal_address_attestation_version = NULL,
              solicitation_postal_address_attested_digest = NULL
          WHERE id = ${businessId}::uuid
            AND account_id = ${accountId()}::uuid
        `;
      }
    });
  },
);
