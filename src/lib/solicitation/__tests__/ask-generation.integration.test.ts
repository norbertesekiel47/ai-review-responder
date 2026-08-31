import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
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

// #1011 — WHY THE VOCABULARY MODULE IS MOCKED (the
// `src/lib/auto-approval/__tests__/suspension.integration.test.ts` precedent).
// Two titles below must force a REAL ledger rejection out of the REAL helper
// inside the REAL persist transaction; a mocked-away helper would prove only
// that a stub can reject, and every other title here supplies valid input.
// Bending ONE map entry to a category migration 116's CHECK does not admit
// makes the ledger INSERT raise 23514 — exactly the writer bug the design says
// must abort the decision rather than be caught.
//
// The stand-in map is DERIVED from the real one inside the factory and never
// re-typed: every other title runs against the production vocabulary, and a
// hand-copied map here would be a second authority over the same three codes.
const { renderRefusalCategories } = vi.hoisted(() => ({
  renderRefusalCategories: {} as Record<string, string>,
}));

vi.mock('@/lib/refusals/vocabulary', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/refusals/vocabulary')>();
  Object.assign(renderRefusalCategories, actual.OUTREACH_WITHHELD_RENDER_REFUSAL_CATEGORIES);
  return { ...actual, OUTREACH_WITHHELD_RENDER_REFUSAL_CATEGORIES: renderRefusalCategories };
});

import { OPENAI_MODEL } from '@/lib/llm/tasks';
import { CostLimitExceededError } from '@/lib/costs/tracker';
import { SOLICITATION_ASK_PROMPT_VERSION, solicitationAskPromptHash } from '../ask-prompt-policy';
import { ASK_LINT_VERSION } from '../ask-compliance-lint';
import { insertOutreachRender } from '../outreach';
import { acquireSolicitationBatchLock } from '../batch-builder';
import { approveBatch, type ApproveBatchResult } from '../approval';
import { startOrGetSolicitationSendBatchRun } from '@/lib/agents/run-spine';
import {
  generateAsksForBatch,
  regenerateAsk,
  settleGenerationExhaustion,
} from '../ask-generation';

const testDatabaseUrl = resolveTestDatabaseUrl();

const businessId = randomUUID();
const uploadId = randomUUID();
const batchId = randomUUID();

let db: postgresType.Sql | undefined;
let featureDatabaseLock: LiveDbLock | undefined;
let tenant: TenantSeed | undefined;
let flagBefore: string | undefined;
let ledgerFlagBefore: string | undefined;

/** The Refusal ledger's default-ON kill switch. Only 'false' disables it. */
const LEDGER_FLAG = 'REFUSAL_LEDGER_ENABLED';

/** The category migration 116's `refusal_category` CHECK will never admit. */
const UNKNOWN_CATEGORY = 'a_category_the_ledger_never_named';

/** Postgres' CHECK-violation SQLSTATE. */
const CHECK_VIOLATION = '23514';

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

// ── #1011 · the outreach_withheld RENDER lane ────────────────────────────────

interface RefusalRow {
  id: string;
  account_id: string;
  business_id: string | null;
  refusal_source: string;
  refusal_code: string | null;
  all_refusal_codes: string[] | null;
  refusal_category: string;
  subject_type: string | null;
  subject_id: string | null;
}

/** Every Refusal this tenant holds, oldest first. */
async function readRefusalRows(): Promise<RefusalRow[]> {
  return sql()<RefusalRow[]>`
    SELECT id::text AS id,
           account_id::text AS account_id,
           business_id::text AS business_id,
           refusal_source,
           refusal_code,
           all_refusal_codes,
           refusal_category,
           subject_type,
           subject_id::text AS subject_id
    FROM refusal_events
    WHERE account_id = ${accountId()}::uuid
    ORDER BY occurred_at, id
  `;
}

async function countRefusalRows(): Promise<number> {
  const [row] = await sql()<{ n: number }[]>`
    SELECT COUNT(*)::int AS n FROM refusal_events
    WHERE account_id = ${accountId()}::uuid
  `;
  return row?.n ?? 0;
}

interface OutreachRow {
  id: string;
  ask_id: string;
  attempt_no: number;
  delivery_status: string;
  disposition_reason: string | null;
}

/** Every attempt row of the batch WITH its id, oldest first. */
async function readOutreachRows(): Promise<OutreachRow[]> {
  return sql()<OutreachRow[]>`
    SELECT id::text AS id, ask_id::text AS ask_id, attempt_no,
           delivery_status, disposition_reason
    FROM solicitation_outreach
    WHERE batch_id = ${batchId}::uuid
      AND account_id = ${accountId()}::uuid
      AND business_id = ${businessId}::uuid
    ORDER BY rendered_at, id
  `;
}

/**
 * Run `body` with ONE render-lane reason mapped to a category the schema
 * rejects, then put the production map back whatever happens.
 */
async function withBentCategory<T>(code: string, body: () => Promise<T>): Promise<T> {
  const original = renderRefusalCategories[code];
  renderRefusalCategories[code] = UNKNOWN_CATEGORY;
  try {
    return await body();
  } finally {
    if (original === undefined) delete renderRefusalCategories[code];
    else renderRefusalCategories[code] = original;
  }
}

/**
 * A `Sql` whose every `begin` aborts — AFTER the callback has committed its
 * work to the transaction — once a Refusal is visible on that same `tx`.
 *
 * This is the SUCCESS-PATH twin of the forced-`23514` cases, and the only
 * shape that discriminates invariant #15 for this lane: the CHECK violation
 * fails on the caller's `tx` and on a private connection alike, so nothing is
 * written either way and the two are indistinguishable there (measured on the
 * suspension lane by red-team RT-8). Here the ledger write SUCCEEDS first and
 * the caller then aborts for a reason that has nothing to do with the ledger,
 * so a helper that opened its own connection has already committed its row
 * independently and the final count is 1 instead of 0.
 *
 * The count is read INSIDE the transaction: a writer that silently wrote
 * nothing would otherwise satisfy the zero-rows assertion by vacuum.
 */
function abortAfterLedgerWrite(base: postgresType.Sql, abort: Error): postgresType.Sql {
  return new Proxy(base as unknown as object, {
    apply: (target, _thisArg, args) =>
      (target as unknown as (...callArgs: unknown[]) => unknown)(...args),
    get: (target, property) => {
      if (property === 'begin') {
        return async (callback: (tx: postgresType.TransactionSql) => Promise<unknown>) =>
          base.begin(async (tx) => {
            const value = await callback(tx);
            const [row] = await tx<{ ledger_rows: number }[]>`
              SELECT COUNT(*)::int AS ledger_rows
              FROM refusal_events
              WHERE account_id = ${accountId()}::uuid
            `;
            if ((row?.ledger_rows ?? 0) > 0) throw abort;
            return value;
          });
      }
      const value = Reflect.get(target, property) as unknown;
      return typeof value === 'function'
        ? (value as (...callArgs: unknown[]) => unknown).bind(target)
        : value;
    },
  }) as unknown as postgresType.Sql;
}

/**
 * Hold the per-Business advisory lock on a SEPARATE connection for `holdMs`,
 * so the next persist transaction blocks on it after its own `BEGIN`.
 */
function holdBatchAdvisoryLock(holdMs: number): {
  acquired: Promise<void>;
  released: Promise<void>;
} {
  const blocker = postgres(assertLocalTestDatabaseUrl(testDatabaseUrl), {
    max: 1,
    prepare: false,
  });
  let signalAcquired: () => void = () => undefined;
  const acquired = new Promise<void>((resolve) => {
    signalAcquired = resolve;
  });
  const released = blocker
    .begin(async (tx) => {
      await acquireSolicitationBatchLock(tx, businessId);
      signalAcquired();
      await new Promise((resolve) => setTimeout(resolve, holdMs));
    })
    .then(async () => {
      await blocker.end({ timeout: 5 });
    });
  return { acquired, released };
}

/** The send parent every regeneration and exhaustion settlement joins to. */
async function mintSendParentRun(): Promise<string> {
  const parent = await sql().begin(async (tx) =>
    startOrGetSolicitationSendBatchRun(tx, {
      batchId,
      accountId: accountId(),
      businessId,
      correlationId: 'refusal-render-lane',
    }));
  return parent.runId;
}

/** Re-open the shared batch after a writer settled and closed it. */
async function reopenBatch(): Promise<void> {
  await sql()`
    UPDATE solicitation_batches SET send_closed_at = NULL
    WHERE id = ${batchId}::uuid AND account_id = ${accountId()}::uuid
  `;
}

const ATTESTED_POSTAL_ADDRESS = '900 Ledger Way\nAustin, TX 78701';

/** Attest the fixture's postal address so a child RENDERS instead of failing closed. */
async function attestPostalAddress(): Promise<void> {
  await sql()`
    UPDATE businesses
    SET solicitation_postal_address = ${ATTESTED_POSTAL_ADDRESS},
        solicitation_postal_address_attested_at = NOW(),
        solicitation_postal_address_attested_by_user_id = ${tenant!.userId}::uuid,
        solicitation_postal_address_attestation_version = 'postal_address_attestation_v1',
        solicitation_postal_address_attested_digest =
          encode(sha256(convert_to(${ATTESTED_POSTAL_ADDRESS}::text, 'UTF8')), 'hex')
    WHERE id = ${businessId}::uuid AND account_id = ${accountId()}::uuid
  `;
}

/** Restore the suite's default UNATTESTED fixture (all five columns, 099). */
async function clearPostalAddress(): Promise<void> {
  await sql()`
    UPDATE businesses
    SET solicitation_postal_address = NULL,
        solicitation_postal_address_attested_at = NULL,
        solicitation_postal_address_attested_by_user_id = NULL,
        solicitation_postal_address_attestation_version = NULL,
        solicitation_postal_address_attested_digest = NULL
    WHERE id = ${businessId}::uuid AND account_id = ${accountId()}::uuid
  `;
}

interface FourWriterDrive {
  /** W1 — the withheld child render. */
  persistChildRender: string;
  /** W2 — the rows the budget stop settled, one id each. */
  settleBudgetStop: string[];
  /** W3 — the withheld REPLACEMENT a regeneration inserted. */
  regenerateAsk: string;
  /** W4 — the hole terminal exhaustion filled. */
  settleGenerationExhaustion: string;
}

/**
 * Drive ALL FOUR render writers once each against the real schema, and return
 * the outreach id every one of them withheld.
 *
 * The batch generation entry point reaches W1 and W2 ONLY (round 1, R1-10);
 * `regenerateAsk` and `settleGenerationExhaustion` are separate exported
 * entry points with their own fixtures. The shared batch is re-opened between
 * legs because each leg settles it (nothing stays alive under an unattested
 * postal address).
 */
async function driveAllFourRenderWriters(): Promise<FourWriterDrive> {
  // W1 + W2. ask-1's reservation succeeds and its render is withheld
  // lint_failed (unattested address); ask-2's reservation is refused, so
  // ask-2 AND ask-3 are settled render_failed by the budget stop.
  const askOne = await seedSendAsk(1);
  const askTwo = await seedSendAsk(2);
  const askThree = await seedSendAsk(3);
  costMocks.reserveCost
    .mockResolvedValueOnce('2026-07-31')
    .mockRejectedValueOnce(new CostLimitExceededError(businessId));
  await generateAsksForBatch(sql(), {
    batchId,
    businessId,
    outboxHandle: await seedDispatchedOutboxRow(),
  });

  // W3. A live RENDERED row is the only thing regeneration may replace.
  await reopenBatch();
  const askFour = await seedSendAsk(4);
  await seedRenderedAttempt(askFour);
  await mintSendParentRun();
  await regenerateAsk(sql(), {
    batchId,
    businessId,
    askId: askFour,
    outboxHandle: await seedDispatchedOutboxRow('regenerate_solicitation_ask'),
  });

  // W4. One send ask with no outreach row at all is the hole exhaustion fills.
  await reopenBatch();
  const askFive = await seedSendAsk(5);
  await settleGenerationExhaustion(sql(), {
    batchId,
    businessId,
    outboxHandle: await seedDispatchedOutboxRow('generate_solicitation_asks_dead_letter'),
    errorClass: 'LLMStructuredOutputError',
  });

  const rows = await readOutreachRows();
  const withheldOf = (askId: string): string => {
    const row = rows.find(
      (candidate) => candidate.ask_id === askId && candidate.delivery_status === 'withheld',
    );
    if (!row) throw new Error(`expected a withheld outreach row for ask ${askId}`);
    return row.id;
  };
  return {
    persistChildRender: withheldOf(askOne),
    settleBudgetStop: [withheldOf(askTwo), withheldOf(askThree)],
    regenerateAsk: withheldOf(askFour),
    settleGenerationExhaustion: withheldOf(askFive),
  };
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
      ledgerFlagBefore = process.env[LEDGER_FLAG];
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
      // The kill switch is per-test state (#1011); restore it before anything
      // else so a failing assertion cannot leave the ledger dark for the rest
      // of the file.
      if (ledgerFlagBefore === undefined) delete process.env[LEDGER_FLAG];
      else process.env[LEDGER_FLAG] = ledgerFlagBefore;
      if (!db) return;
      // `refusal_events.subject_id` is a bare UUID with no FK to
      // solicitation_outreach, so nothing here cascades — the ledger is
      // cleared explicitly or every later count starts dirty.
      await db`DELETE FROM refusal_events WHERE account_id = ${accountId()}::uuid`;
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

    // X18 (2026-08-22 pass). `agent_runs.subject_id` is TEXT (migration 071),
    // so a compare against it is case-SENSITIVE, while every `::uuid` cast
    // normalises. Before the fix `settleGenerationExhaustion` bound the SAME
    // `input.batchId` both ways inside ONE transaction — `WHERE id = $1::uuid`
    // found and locked the batch, `AND subject_id = $1` MISSED its send parent
    // — so every filled hole took `agentRunId: null` and the generation steps
    // were skipped. Silently, while `closeBatchIfSettled` forty lines later
    // lowercased internally and DID find the same parent.
    //
    // The id arrives UPPERCASED here because that is the shape the defect
    // needs and the shape `isValidUuid` accepts. A lowercase id passes with the
    // canonicaliser deleted, which is why this case would not be a test.
    it('lands the exhaustion fills and the generation steps on the send parent for an UPPERCASED batch id', async () => {
      const askId = await seedSendAsk(1);
      const handle = await seedDispatchedOutboxRow();

      // The parent the generation lane mints before it dies. Written through
      // the real spine writer, so its `subject_id` is whatever production
      // stores rather than whatever this test would have spelled.
      const parent = await sql().begin(async (tx) =>
        startOrGetSolicitationSendBatchRun(tx, {
          batchId,
          accountId: accountId(),
          businessId,
          correlationId: 'settle-exhaustion-uppercase',
        }));
      const parentRunId = parent.runId;

      const settled = await settleGenerationExhaustion(sql(), {
        batchId: batchId.toUpperCase(),
        businessId,
        outboxHandle: handle,
        errorClass: 'LLMStructuredOutputError',
      });

      // The batch WAS found and locked — the `::uuid` cast never had the bug,
      // and that asymmetry is the whole defect.
      expect(settled).toMatchObject({ status: 'settled', filled: 1 });

      // THE claim. `agentRunId: parent?.id ?? null` is written on every fill,
      // so a missed parent is a `render_failed` row with no run behind it and
      // nothing downstream that can attribute it.
      const [fill] = await sql()<{ agent_run_id: string | null; delivery_status: string }[]>`
        SELECT agent_run_id::text AS agent_run_id, delivery_status
        FROM solicitation_outreach
        WHERE ask_id = ${askId}::uuid
          AND account_id = ${accountId()}::uuid
          AND business_id = ${businessId}::uuid
      `;
      expect(fill).toBeDefined();
      expect(fill!.delivery_status).toBe('withheld');
      expect(fill!.agent_run_id).toBe(parentRunId);

      // The second half the missed parent cost: `recordGenerationSteps` runs
      // only `if (parent)`, so the receipt for everything the lane did was
      // skipped outright.
      const steps = await sql()<{ step_key: string }[]>`
        SELECT step_key FROM agent_run_steps
        WHERE agent_run_id = ${parentRunId}::uuid
        ORDER BY step_index
      `;
      expect(steps.map((step) => step.step_key)).toContain('ask_generated');
    });

    // ── #1011 · the outreach_withheld RENDER lane ───────────────────────────
    //
    // The REAL `writeRefusalEvent` against the REAL `refusal_events` table,
    // inside the REAL persist / swap / settlement transactions. The unit
    // sibling owns the per-call SHAPE; what only Postgres can answer lives
    // here: the row's validity under migration 116's five CHECKs, the
    // column-to-column timestamp equality, and whether a Refusal survives a
    // rollback of the decision it records.
    describe('the outreach_withheld render lane', () => {
      it('a withheld child render writes one refusal_events row against the outreach id', async () => {
        const askId = await seedSendAsk(1);

        const result = await generateAsksForBatch(sql(), {
          batchId,
          businessId,
          outboxHandle: await seedDispatchedOutboxRow(),
        });
        expect(result).toMatchObject({ rendered: 0, withheld: 1, failed: 0 });

        const [outreach] = await readOutreachRows();
        expect(outreach).toMatchObject({
          ask_id: askId,
          delivery_status: 'withheld',
          disposition_reason: 'lint_failed',
        });

        const refusals = await readRefusalRows();
        expect(refusals).toHaveLength(1);
        expect(refusals[0]).toMatchObject({
          account_id: accountId(),
          business_id: businessId,
          refusal_source: 'outreach_withheld',
          refusal_code: 'lint_failed',
          refusal_category: 'below_our_bar',
          subject_type: 'solicitation_outreach',
          subject_id: outreach!.id,
          all_refusal_codes: null,
        });
      });

      it('a successful child render writes no refusal_events row', async () => {
        await attestPostalAddress();
        try {
          await seedSendAsk(1);
          const result = await generateAsksForBatch(sql(), {
            batchId,
            businessId,
            outboxHandle: await seedDispatchedOutboxRow(),
          });
          expect(result).toMatchObject({ rendered: 1, withheld: 0, failed: 0 });
          expect(await readRefusalRows()).toEqual([]);
        } finally {
          await clearPostalAddress();
        }
      });

      it('every render-lane refusal_events row carries occurred_at equal to the solicitation_outreach rendered_at of the same insert', async () => {
        const drive = await driveAllFourRenderWriters();

        // Compared as COLUMNS, in SQL. Reading either side back through
        // postgres.js truncates MICROSECONDS (#520), which would make an
        // unequal pair look equal at exactly the resolution that matters.
        const pairs = await sql()<{ subject_id: string; timestamps_equal: boolean }[]>`
          SELECT r.subject_id::text AS subject_id,
                 (r.occurred_at = o.rendered_at) AS timestamps_equal
          FROM refusal_events r
          JOIN solicitation_outreach o ON o.id = r.subject_id
          WHERE r.account_id = ${accountId()}::uuid
        `;
        expect(pairs).toHaveLength(5);
        expect(pairs.every((pair) => pair.timestamps_equal)).toBe(true);
        // Every Refusal joined to an outreach row — none is orphaned, and all
        // four writers are represented.
        expect(await countRefusalRows()).toBe(5);
        expect(new Set(pairs.map((pair) => pair.subject_id))).toEqual(
          new Set([
            drive.persistChildRender,
            ...drive.settleBudgetStop,
            drive.regenerateAsk,
            drive.settleGenerationExhaustion,
          ]),
        );
      });

      it('the render lane never stamps occurred_at from the transaction, so a slow lock does not move the decision time', async () => {
        // The persist transaction is made to WAIT: a second connection holds
        // the per-Business advisory lock for 600ms across the whole window
        // between the render decision and the insert. The decided design
        // captures the clock BEFORE that wait, so both stamps land within a
        // few milliseconds of `lockHeldAt`; the design round 1 rejected reads
        // the clock INSIDE the transaction, after the lock is granted, so both
        // would land at `lockHeldAt + 600ms` or later.
        //
        // EVERY COMPARISON BELOW STAYS ON ONE CLOCK. `rendered_at` and
        // `occurred_at` are app-supplied JS `Date`s and `lockHeldAt` is
        // `Date.now()` in the same process; the container's Postgres clock
        // runs tens of milliseconds off this one, so a JS-value-vs-`NOW()`
        // comparison would measure that skew instead of the design.
        const HOLD_MS = 600;
        await seedSendAsk(1);
        const handle = await seedDispatchedOutboxRow();

        let blocker: { acquired: Promise<void>; released: Promise<void> } | undefined;
        let lockHeldAt = 0;
        const structured = {
          subject: 'Thanks for visiting Ask Generation Business',
          body: 'Hi Alice, thanks for coming by Ask Generation Business. Would you share how it went?',
        };
        llmMocks.runLlmTask.mockImplementationOnce(async () => {
          // Taken INSIDE the LLM round trip — the exact window between the
          // render decision and the persist transaction.
          blocker = holdBatchAdvisoryLock(HOLD_MS);
          await blocker.acquired;
          lockHeldAt = Date.now();
          return {
            text: JSON.stringify(structured),
            provider: 'openai',
            model: OPENAI_MODEL,
            usage: { promptTokens: 500, completionTokens: 120 },
            structured,
          };
        });

        const startedAt = Date.now();
        await generateAsksForBatch(sql(), { batchId, businessId, outboxHandle: handle });
        const elapsedMs = Date.now() - startedAt;
        await blocker?.released;

        // The contention was real, not hoped for.
        expect(lockHeldAt).toBeGreaterThan(0);
        expect(elapsedMs).toBeGreaterThanOrEqual(HOLD_MS);

        const [row] = await sql()<
          {
            rendered_at_ms: string;
            occurred_at_ms: string;
            same_transaction: boolean;
            timestamps_equal: boolean;
          }[]
        >`
          SELECT (EXTRACT(EPOCH FROM o.rendered_at) * 1000)::bigint::text AS rendered_at_ms,
                 (EXTRACT(EPOCH FROM r.occurred_at) * 1000)::bigint::text AS occurred_at_ms,
                 (r.created_at = o.created_at) AS same_transaction,
                 (r.occurred_at = o.rendered_at) AS timestamps_equal
          FROM refusal_events r
          JOIN solicitation_outreach o ON o.id = r.subject_id
          WHERE r.account_id = ${accountId()}::uuid
        `;
        expect(row).toBeDefined();
        expect(row!.timestamps_equal).toBe(true);
        // `created_at` on BOTH tables is `DEFAULT NOW()`, so equality here is
        // Postgres' own statement that the two rows were written by ONE
        // transaction — a DB-clock-to-DB-clock comparison, unaffected by skew.
        expect(row!.same_transaction).toBe(true);
        // THE DISCRIMINATOR: the decision time did not move by the lock wait.
        expect(Number(row!.rendered_at_ms)).toBeLessThan(lockHeldAt + HOLD_MS);
        expect(Number(row!.occurred_at_ms)).toBeLessThan(lockHeldAt + HOLD_MS);
      });

      it('a budget stop writes one refusal_events row per outreach it settles as withheld', async () => {
        const askOne = await seedSendAsk(1);
        await seedSendAsk(2);
        await seedSendAsk(3);
        costMocks.reserveCost
          .mockResolvedValueOnce('2026-07-31')
          .mockRejectedValueOnce(new CostLimitExceededError(businessId));

        await generateAsksForBatch(sql(), {
          batchId,
          businessId,
          outboxHandle: await seedDispatchedOutboxRow(),
        });

        const rows = await readOutreachRows();
        const settled = rows.filter((row) => row.ask_id !== askOne);
        // MORE THAN ONE settled row is the whole point: a single-row fixture
        // cannot tell "one Refusal per outreach" from "one per call".
        expect(settled).toHaveLength(2);
        expect(settled.every((row) => row.disposition_reason === 'render_failed')).toBe(true);

        const refusals = await readRefusalRows();
        const settledIds = new Set(settled.map((row) => row.id));
        const budgetRefusals = refusals.filter((refusal) =>
          settledIds.has(refusal.subject_id ?? ''));
        expect(budgetRefusals).toHaveLength(2);
        expect(new Set(budgetRefusals.map((refusal) => refusal.subject_id))).toEqual(settledIds);
        expect(budgetRefusals.every((refusal) => refusal.refusal_code === 'render_failed')).toBe(
          true,
        );
      });

      it('a generation exhaustion writes one refusal_events row per outreach hole it settles as withheld', async () => {
        const askOne = await seedSendAsk(1);
        await seedSendAsk(2);
        await seedSendAsk(3);
        // ask-1 already holds a render, so it is NOT a hole — the other two
        // are, and `settleGenerationExhaustion` loops over them in ONE call.
        await seedRenderedAttempt(askOne);
        await mintSendParentRun();

        const settled = await settleGenerationExhaustion(sql(), {
          batchId,
          businessId,
          outboxHandle: await seedDispatchedOutboxRow(),
          errorClass: 'LLMStructuredOutputError',
        });
        expect(settled).toMatchObject({ status: 'settled', filled: 2 });

        const fills = (await readOutreachRows()).filter(
          (row) => row.delivery_status === 'withheld',
        );
        expect(fills).toHaveLength(2);

        const refusals = await readRefusalRows();
        // ONE PER HOLE. A writer that recorded one Refusal per INVOCATION
        // would sit at 1 here and pass a one-hole fixture (round 1, R1-2).
        expect(refusals).toHaveLength(2);
        expect(new Set(refusals.map((refusal) => refusal.subject_id))).toEqual(
          new Set(fills.map((fill) => fill.id)),
        );
      });

      it('a regenerated ask writes its refusal_events row against the replacement outreach id', async () => {
        const askId = await seedSendAsk(1);
        await seedRenderedAttempt(askId);
        await mintSendParentRun();
        const [replaced] = await readOutreachRows();

        await regenerateAsk(sql(), {
          batchId,
          businessId,
          askId,
          outboxHandle: await seedDispatchedOutboxRow('regenerate_solicitation_ask'),
        });

        const rows = await readOutreachRows();
        expect(rows).toHaveLength(2);
        const replacement = rows.find((row) => row.attempt_no === 2);
        expect(replacement).toMatchObject({
          delivery_status: 'withheld',
          disposition_reason: 'lint_failed',
        });

        const refusals = await readRefusalRows();
        expect(refusals).toHaveLength(1);
        // The replacement is a DISTINCT subject with its own id.
        expect(refusals[0]!.subject_id).toBe(replacement!.id);
        expect(refusals[0]!.subject_id).not.toBe(replaced!.id);
      });

      it('a successful regenerated ask writes no refusal_events row for its rendered replacement', async () => {
        // `regenerateAsk` inserts a replacement whether the new render
        // SUCCEEDED or was withheld (AMEND B2), so an unconditional ledger
        // call would pass every other regeneration title here (round 1, R1-3).
        await attestPostalAddress();
        try {
          const askId = await seedSendAsk(1);
          await seedRenderedAttempt(askId);
          await mintSendParentRun();

          await regenerateAsk(sql(), {
            batchId,
            businessId,
            askId,
            outboxHandle: await seedDispatchedOutboxRow('regenerate_solicitation_ask'),
          });

          const rows = await readOutreachRows();
          expect(rows).toHaveLength(2);
          expect(rows.find((row) => row.attempt_no === 2)).toMatchObject({
            delivery_status: 'rendered',
            disposition_reason: null,
          });
          expect(await readRefusalRows()).toEqual([]);
        } finally {
          await clearPostalAddress();
        }
      });

      it('a withheld regeneration writes no refusal_events row against the rendered outreach it replaces', async () => {
        // Regeneration REQUIRES the current row to be `rendered`, before and
        // inside the swap — and a rendered row was never withheld, so the row
        // being replaced has no render-lane Refusal to keep or to gain. Round
        // 1 killed the earlier claim as a state the code forbids.
        const askId = await seedSendAsk(1);
        await seedRenderedAttempt(askId);
        await mintSendParentRun();
        const [replaced] = await readOutreachRows();
        expect(replaced).toMatchObject({ delivery_status: 'rendered' });

        await regenerateAsk(sql(), {
          batchId,
          businessId,
          askId,
          outboxHandle: await seedDispatchedOutboxRow('regenerate_solicitation_ask'),
        });

        const refusals = await readRefusalRows();
        expect(refusals).toHaveLength(1);
        expect(
          refusals.filter((refusal) => refusal.subject_id === replaced!.id),
        ).toEqual([]);
      });

      it('a ledger failure rolls back the outreach render insert it accompanies', async () => {
        await seedSendAsk(1);
        const handle = await seedDispatchedOutboxRow();

        await withBentCategory('lint_failed', async () => {
          await expect(
            generateAsksForBatch(sql(), { batchId, businessId, outboxHandle: handle }),
          ).rejects.toMatchObject({
            code: CHECK_VIOLATION,
            constraint_name: expect.stringContaining('refusal_events'),
          });
        });

        // The render the Refusal was recording is gone with it: the outbox
        // attempt is retried, and the ask is un-generated again.
        expect(await readOutreachRows()).toEqual([]);
        expect(await countRefusalRows()).toBe(0);
      });

      it('a ledger failure at each of persistChildRender, regenerateAsk, and settleGenerationExhaustion rolls back the outreach insert it accompanies', async () => {
        // Three SEPARATE transactions with three separate ladders. One W1
        // fixture proves nothing about the swap transaction or the hole-fill
        // transaction (round 1, R1-5).
        const askOne = await seedSendAsk(1);
        await withBentCategory('lint_failed', async () => {
          await expect(
            generateAsksForBatch(sql(), {
              batchId,
              businessId,
              outboxHandle: await seedDispatchedOutboxRow(),
            }),
          ).rejects.toMatchObject({ code: CHECK_VIOLATION });
        });
        expect(await readOutreachRows()).toEqual([]);

        const askTwo = await seedSendAsk(2);
        await seedRenderedAttempt(askTwo);
        await mintSendParentRun();
        await withBentCategory('lint_failed', async () => {
          await expect(
            regenerateAsk(sql(), {
              batchId,
              businessId,
              askId: askTwo,
              outboxHandle: await seedDispatchedOutboxRow('regenerate_solicitation_ask'),
            }),
          ).rejects.toMatchObject({ code: CHECK_VIOLATION });
        });
        // The supersede AND the replacement insert went down together: the
        // ask still holds its original live render.
        const afterRegen = await readOutreachRows();
        expect(afterRegen).toHaveLength(1);
        expect(afterRegen[0]).toMatchObject({
          ask_id: askTwo,
          attempt_no: 1,
          delivery_status: 'rendered',
        });

        await withBentCategory('render_failed', async () => {
          await expect(
            settleGenerationExhaustion(sql(), {
              batchId,
              businessId,
              outboxHandle: await seedDispatchedOutboxRow(
                'generate_solicitation_asks_dead_letter',
              ),
              errorClass: 'LLMStructuredOutputError',
            }),
          ).rejects.toMatchObject({ code: CHECK_VIOLATION });
        });
        // ask-1 is still the only hole, still unfilled.
        const afterSettle = await readOutreachRows();
        expect(afterSettle).toHaveLength(1);
        expect(afterSettle.some((row) => row.ask_id === askOne)).toBe(false);
        expect(await countRefusalRows()).toBe(0);
      });

      it('a refusal written by each render writer does not survive a later rollback of its outreach transaction', async () => {
        const abort = new Error('caller aborted after the ledger wrote — unrelated to the ledger');
        const aborting = abortAfterLedgerWrite(sql(), abort);

        const askOne = await seedSendAsk(1);
        await expect(
          generateAsksForBatch(aborting, {
            batchId,
            businessId,
            outboxHandle: await seedDispatchedOutboxRow(),
          }),
        ).rejects.toBe(abort);
        expect(await readOutreachRows()).toEqual([]);
        expect(await countRefusalRows()).toBe(0);

        const askTwo = await seedSendAsk(2);
        await seedRenderedAttempt(askTwo);
        await mintSendParentRun();
        await expect(
          regenerateAsk(aborting, {
            batchId,
            businessId,
            askId: askTwo,
            outboxHandle: await seedDispatchedOutboxRow('regenerate_solicitation_ask'),
          }),
        ).rejects.toBe(abort);
        expect(await readOutreachRows()).toHaveLength(1);
        expect(await countRefusalRows()).toBe(0);

        await expect(
          settleGenerationExhaustion(aborting, {
            batchId,
            businessId,
            outboxHandle: await seedDispatchedOutboxRow('generate_solicitation_asks_dead_letter'),
            errorClass: 'LLMStructuredOutputError',
          }),
        ).rejects.toBe(abort);
        // ask-1's hole is still a hole, and no Refusal outlived any of the
        // three transactions — which a helper on its own connection could not
        // manage, because its row would already be committed.
        const rows = await readOutreachRows();
        expect(rows).toHaveLength(1);
        expect(rows.some((row) => row.ask_id === askOne)).toBe(false);
        expect(await countRefusalRows()).toBe(0);
      });

      it('every writer still persists its render when REFUSAL_LEDGER_ENABLED is false', async () => {
        process.env[LEDGER_FLAG] = 'false';

        const drive = await driveAllFourRenderWriters();

        const withheldIds = new Set(
          (await readOutreachRows())
            .filter((row) => row.delivery_status === 'withheld')
            .map((row) => row.id),
        );
        expect(withheldIds.size).toBe(5);
        for (const id of [
          drive.persistChildRender,
          ...drive.settleBudgetStop,
          drive.regenerateAsk,
          drive.settleGenerationExhaustion,
        ]) {
          expect(withheldIds.has(id)).toBe(true);
        }
      });

      it('REFUSAL_LEDGER_ENABLED=false writes zero refusal_events rows across all four render writers', async () => {
        // "Still persists its render" alone is satisfied by a writer that
        // bypasses the helper with a raw insert (round 1, R1-4). The point of
        // the kill switch is that NO row is written — and the five withheld
        // rows below are what makes this zero non-vacuous.
        process.env[LEDGER_FLAG] = 'false';

        await driveAllFourRenderWriters();

        const withheld = (await readOutreachRows()).filter(
          (row) => row.delivery_status === 'withheld',
        );
        expect(withheld).toHaveLength(5);
        expect(await countRefusalRows()).toBe(0);
      });
    });
  },
);
