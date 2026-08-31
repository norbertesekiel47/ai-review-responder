import { randomUUID } from 'node:crypto';
import { REFUSAL_LEDGER_FLAG } from '@/lib/refusals/write';
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
  MIGRATION_091_SEND_MODE_SPINE_LIFECYCLE,
  MIGRATION_108_OUTREACH_OWNER_EXCLUDED,
} from '@/lib/shared/__tests__/helpers/schema-ready';
import {
  cleanupLocation,
  cleanupTenantAccount,
  seedLocation,
  seedTenantAccount,
  type TenantSeed,
} from '@/lib/shared/__tests__/live-db-tenant';
import { checksum, insertOutreach, seedContactCsvUpload } from '@/lib/shared/__tests__/helpers/outreach-fixture';
import { abortingExecutor } from '@/lib/shared/__tests__/helpers/abort-injection';

// DELEGATING spies over the three collaborators the admin arm's ORDER claim is
// about (#865). Each forwards to the real implementation, so every pre-existing
// case in this file keeps running against real Postgres; the spies exist so a
// case can name WHICH object a collaborator was handed and WHEN it was called.
// "Both rows exist" is not sufficient evidence for either claim: it passes when
// the audit ran on the base client, and it passes when the audit ran AFTER
// recordStep — the lock-order regression.
const spies = vi.hoisted(() => ({
  recordStep: vi.fn(),
  closeBatchIfSettled: vi.fn(),
  writeAccountAuditLog: vi.fn(),
}));

vi.mock('@/lib/agents/run-spine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/agents/run-spine')>();
  spies.recordStep.mockImplementation(actual.recordStep);
  return { ...actual, recordStep: spies.recordStep };
});
vi.mock('../outreach', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../outreach')>();
  spies.closeBatchIfSettled.mockImplementation(actual.closeBatchIfSettled);
  return { ...actual, closeBatchIfSettled: spies.closeBatchIfSettled };
});
vi.mock('@/lib/audit/log', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/audit/log')>();
  spies.writeAccountAuditLog.mockImplementation(actual.writeAccountAuditLog);
  return { ...actual, writeAccountAuditLog: spies.writeAccountAuditLog };
});

// ── #1010 T5: the `batch_halted` lane's Refusal write site ──────────────────
//
// WHY THE VOCABULARY MODULE IS MOCKED. One case here forces a REAL ledger
// rejection from the REAL helper inside the latch transaction — a mocked-away
// writer would prove only that a stub can reject, and every other case supplies
// valid input. Bending ONE map entry to a category migration 116's CHECK does
// not admit makes the INSERT violate `refusal_events_refusal_category_check`,
// which is the writer bug the design says must abort the decision rather than
// be caught. Same shape as
// `src/lib/auto-approval/__tests__/suspension.integration.test.ts`.
//
// The stand-in map is DERIVED from the real one inside the factory, never
// re-typed: every other case must run against the production vocabulary.
const { batchHaltedCategories } = vi.hoisted(() => ({
  batchHaltedCategories: {} as Record<string, string | null>,
}));

vi.mock('@/lib/refusals/vocabulary', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/refusals/vocabulary')>();
  Object.assign(batchHaltedCategories, actual.BATCH_HALTED_REFUSAL_CATEGORIES);
  return { ...actual, BATCH_HALTED_REFUSAL_CATEGORIES: batchHaltedCategories };
});

import { QUEUE_NAMES } from '@/lib/shared/queue-names';
import { BATCH_HALTED_REFUSAL_CATEGORIES } from '@/lib/refusals/vocabulary';
import { acquireSolicitationBatchLock } from '../batch-builder';
import { insertOutreachRender, type InsertOutreachRenderInput } from '../outreach';
import {
  approveBatch,
  haltBatch,
  requestAskRegeneration,
  withdrawAsk,
  type RequestAskRegenerationResult,
} from '../approval';
// NAMESPACE import for the admin arm (#865). A named `import { adminHaltBatch }`
// of an export that does not exist yet fails the whole FILE at collection —
// vite's ssr transform validates importedNames — which would take every
// pre-existing case in this suite down with it and run none of the titles this
// eval promises. A namespace access is `undefined` until Task 1 lands, so each
// admin case fails on its own, naming the missing export.
import * as approvalModule from '../approval';

// Live-DB suite for the two owner approval-lane writers (#629 T3/T4). Applies
// NO migration SQL: `pnpm test:db:setup` provisions the schema and this file
// asserts it with assertSchemaReady (#573). It holds the cross-process live-DB
// lock because the interleaving case depends on two of its OWN connections
// contending on one batch's advisory lock — an unrelated writer in another
// vitest process would make that interleaving unreadable.
//
// Every lifecycle timestamp is written as a SQL interval off NOW(), never as a
// JS `Date`: postgres.js truncates timestamptz microseconds, so a JS-derived
// `built_at` can land before the NOW()-defaulted `created_at` it must not
// precede and trip a constraint that has nothing to do with the case under test.

const testDatabaseUrl = resolveTestDatabaseUrl();
const businessId = randomUUID();
// A SECOND location under the SAME account. It exists so the tenant-scope case
// can probe the boundary a single-key `WHERE id = …` would wrongly pass: the
// right owner, reaching for a batch that belongs to their other location.
const siblingBusinessId = randomUUID();
// The acting RepWorth operator (D1). Seeded as a `users` row with role 'admin'
// and NO account_id: `halted_by` is a FK to the GLOBAL users table, not a
// tenant member, and `halt_reason='admin_halt'` — not this id — is the
// discriminator for actor class.
const adminUserId = randomUUID();
/** Required free-text note (D10); it rides the audit payload, never halt_reason. */
const ADMIN_NOTE = 'Owner called support and asked us to stop this batch.';

let db: postgresType.Sql | undefined;
// The interleaving case holds an uncommitted child-render transaction open
// while the approval blocks on the same advisory key. That needs a SECOND
// connection: `approveBatch` is handed the pooled handle, and a pool whose only
// free connection is the one holding the lock deadlocks against itself.
let writerDb: postgresType.Sql | undefined;
let featureDatabaseLock: LiveDbLock | undefined;
let tenant: TenantSeed | undefined;
// A genuinely separate billing parent, not a fabricated uuid: the foreign-scope
// case should fail because the batch belongs to someone else, not because the
// account it names does not exist.
let foreignTenant: TenantSeed | undefined;

function sql(): postgresType.Sql {
  if (!db) throw new Error('approval integration database was not initialized');
  return db;
}

function writerSql(): postgresType.Sql {
  if (!writerDb) throw new Error('approval integration writer connection was not initialized');
  return writerDb;
}

function accountId(): string {
  if (!tenant) throw new Error('approval integration tenant was not seeded');
  return tenant.accountId;
}

function userId(): string {
  if (!tenant) throw new Error('approval integration tenant was not seeded');
  return tenant.userId;
}

function foreignTenantSeed(): TenantSeed {
  if (!foreignTenant) throw new Error('approval integration foreign tenant was not seeded');
  return foreignTenant;
}

async function seedUpload(): Promise<string> {
  return seedContactCsvUpload(sql(), {
    accountId: accountId(),
    businessId,
    attestedByUserId: userId(),
    filenamePrefix: 'approval',
    attestationVersion: 'approval-test',
  });
}

async function seedContact(uploadId: string): Promise<string> {
  const contactId = randomUUID();
  await sql()`
    INSERT INTO solicitation_contacts (
      id, business_id, name, email, created_by_upload_id
    ) VALUES (
      ${contactId}::uuid, ${businessId}::uuid, 'Approval Candidate',
      ${`${contactId}@example.test`}, ${uploadId}::uuid
    )
  `;
  return contactId;
}

/** One batch under the seeded business. `created_at` is anchored 40 days back
 *  so any `built_at` a case needs still satisfies the built-after-created arm. */
async function seedBatch(builtAgo: string): Promise<{ batchId: string; uploadId: string }> {
  const uploadId = await seedUpload();
  const batchId = randomUUID();
  await sql()`
    INSERT INTO solicitation_batches (
      id, account_id, business_id, source_upload_id, created_at, built_at
    ) VALUES (
      ${batchId}::uuid, ${accountId()}::uuid, ${businessId}::uuid,
      ${uploadId}::uuid, NOW() - INTERVAL '40 days', NOW() - ${builtAgo}::interval
    )
  `;
  return { batchId, uploadId };
}

/** A batch the builder has not finished: `built_at IS NULL`, state `pending`.
 *  Shared by BOTH halt verbs' pending cases — the guard is now identical. */
async function seedUnbuiltBatch(): Promise<string> {
  const uploadId = await seedUpload();
  const batchId = randomUUID();
  await sql()`
    INSERT INTO solicitation_batches (
      id, account_id, business_id, source_upload_id, created_at, built_at
    ) VALUES (
      ${batchId}::uuid, ${accountId()}::uuid, ${businessId}::uuid,
      ${uploadId}::uuid, NOW() - INTERVAL '1 minute', NULL
    )
  `;
  return batchId;
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
      'running', NOW() - INTERVAL '1 minute', 'approval-integration'
    )
  `;
  return runId;
}

interface SeededAsk {
  askId: string;
  contactId: string;
}

/** One `send` ask with its own contact — the live-attempt index is per-ask. */
async function seedSendAsk(batchId: string, uploadId: string): Promise<SeededAsk> {
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
        policy_version: 'approval-fixture',
        decision: 'send',
      })},
      NOW()
    )
  `;
  return { askId, contactId };
}

/**
 * One `withhold` ask. 088's status/reason CHECK and 090's evidence CHECK both
 * have to agree, so the reason is spelled in the column AND in the evidence.
 *
 * This is the shape a batch carries when every candidate was withheld at
 * decision time — the one build that skips the generation enqueue outright
 * (`summary.sendCount === 0`) and therefore never mints a send parent.
 */
async function seedWithholdAsk(batchId: string, uploadId: string): Promise<SeededAsk> {
  const contactId = await seedContact(uploadId);
  const askId = randomUUID();
  await sql()`
    INSERT INTO solicitation_asks (
      id, account_id, business_id, batch_id, contact_id, status,
      withheld_reason, evidence, decided_at
    ) VALUES (
      ${askId}::uuid, ${accountId()}::uuid, ${businessId}::uuid,
      ${batchId}::uuid, ${contactId}::uuid, 'withhold', 'no_consent',
      ${sql().json({
        contact_id: contactId,
        policy_version: 'approval-fixture',
        decision: 'withhold',
        reason: 'no_consent',
      })},
      NOW()
    )
  `;
  return { askId, contactId };
}

interface AttemptInput {
  batchId: string;
  ask: SeededAsk;
  deliveryStatus: 'rendered' | 'queued' | 'sending' | 'withheld' | 'cancelled';
  dispositionReason?: string | null;
  attemptNo?: number;
}

/** One attempt row on an existing ask. Withheld rows are seeded bodyless, the
 *  shape the render lane writes for `render_failed`; every other status keeps
 *  its bodies because `solicitation_outreach_body_presence` requires them.
 *
 *  The dispatch stamps are derived here rather than through the fixture's
 *  `deriveDispatchStamps` helper because that one returns JS `Date`s: 091
 *  requires `queued_at` of every dispatched status and `sending_at` of
 *  `sending`, and this file resolves every stamp in SQL for the microsecond
 *  reason in the header. */
async function seedAttempt(input: AttemptInput): Promise<string> {
  const withheld = input.deliveryStatus === 'withheld';
  const dispatched = input.deliveryStatus === 'queued' || input.deliveryStatus === 'sending';
  return insertOutreach(sql(), {
    accountId: accountId(),
    businessId,
    batchId: input.batchId,
    askId: input.ask.askId,
    contactId: input.ask.contactId,
    attemptNo: input.attemptNo ?? 1,
    ...(withheld ? { renderedSubject: null, renderedBody: null } : {}),
    deliveryStatus: input.deliveryStatus,
    dispositionReason: input.dispositionReason ?? null,
    renderedAt: sql()`NOW() - INTERVAL '1 minute'`,
    ...(dispatched ? { queuedAt: sql()`NOW() - INTERVAL '30 seconds'` } : {}),
    ...(input.deliveryStatus === 'sending'
      ? { sendingAt: sql()`NOW() - INTERVAL '20 seconds'` }
      : {}),
  });
}

interface RenderedBatch {
  batchId: string;
  uploadId: string;
  accountId: string;
  businessId: string;
  userId: string;
  parentRunId: string;
  asks: SeededAsk[];
  outreachIds: string[];
}

/**
 * A built batch with a send parent and `renders` send asks, each carrying one
 * `rendered` attempt — the state generation leaves behind, and the only state
 * `approveBatch` accepts.
 */
async function seedRenderedBatch(
  options: { renders: number; builtAgo?: string },
): Promise<RenderedBatch> {
  const { batchId, uploadId } = await seedBatch(options.builtAgo ?? '1 hour');
  const parentRunId = await seedSendParent(batchId);
  const asks: SeededAsk[] = [];
  const outreachIds: string[] = [];
  for (let index = 0; index < options.renders; index += 1) {
    const ask = await seedSendAsk(batchId, uploadId);
    asks.push(ask);
    outreachIds.push(await seedAttempt({ batchId, ask, deliveryStatus: 'rendered' }));
  }
  return {
    batchId,
    uploadId,
    accountId: accountId(),
    businessId,
    userId: userId(),
    parentRunId,
    asks,
    outreachIds,
  };
}

/** The render lane's insert payload for an ask that has no attempt yet. */
function renderInput(
  batchId: string,
  ask: SeededAsk,
  parentRunId: string,
  attemptNo = 1,
): InsertOutreachRenderInput {
  return {
    accountId: accountId(),
    businessId,
    batchId,
    askId: ask.askId,
    contactId: ask.contactId,
    attemptNo,
    promptVersion: 'solicitation_ask_v1',
    promptHash: checksum(ask.askId),
    askLintVersion: 'ask_lint_v1',
    lintDetail: [],
    moderationStatus: 'clean',
    moderationDetail: {},
    interpolationInputs: {},
    renderedAt: new Date(),
    agentRunId: parentRunId,
    deliveryStatus: 'rendered',
    renderedSubject: 'How did we do?',
    renderedBody: 'Would you mind leaving a review?',
  };
}

interface BatchApprovalRow {
  approval_method: string | null;
  approved_at: string | null;
  approved_by_user_id: string | null;
  veto_deadline_at: string | null;
  send_closed_at: string | null;
  gap_minutes: number | null;
}

async function readBatch(batchId: string): Promise<BatchApprovalRow> {
  const [row] = await sql()<BatchApprovalRow[]>`
    SELECT approval_method,
           approved_at::text AS approved_at,
           approved_by_user_id::text AS approved_by_user_id,
           veto_deadline_at::text AS veto_deadline_at,
           send_closed_at::text AS send_closed_at,
           EXTRACT(EPOCH FROM (veto_deadline_at - approved_at))::int / 60 AS gap_minutes
    FROM solicitation_batches
    WHERE id = ${batchId}::uuid
      AND account_id = ${accountId()}::uuid
      AND business_id = ${businessId}::uuid
  `;
  return row!;
}

interface BatchHaltRow {
  halted_at: string | null;
  halt_reason: string | null;
  halted_by: string | null;
}

async function readHalt(batchId: string): Promise<BatchHaltRow> {
  const [row] = await sql()<BatchHaltRow[]>`
    SELECT halted_at::text AS halted_at,
           halt_reason,
           halted_by::text AS halted_by
    FROM solicitation_batches
    WHERE id = ${batchId}::uuid
      AND account_id = ${accountId()}::uuid
      AND business_id = ${businessId}::uuid
  `;
  return row!;
}

/**
 * Drive a batch into the send lane without a writer. 091's send-ordering CHECK
 * requires approval before sending and its approval-consistency CHECK requires
 * an approver whenever `approval_method='owner'`, so the whole prefix is
 * stamped together or none of it is legal.
 */
async function stampSendingBatch(batchId: string): Promise<void> {
  await sql()`
    UPDATE solicitation_batches
    SET approved_at = NOW() - INTERVAL '20 minutes',
        approval_method = 'owner',
        approved_by_user_id = ${userId()}::uuid,
        veto_deadline_at = NOW() - INTERVAL '5 minutes',
        sending_started_at = NOW() - INTERVAL '4 minutes'
    WHERE id = ${batchId}::uuid
      AND account_id = ${accountId()}::uuid
      AND business_id = ${businessId}::uuid
  `;
}

/** Closure without approval is legal on purpose (091's carve-out): a batch can
 *  close after generation failed or after it expired unapproved. */
async function stampClosedBatch(batchId: string): Promise<void> {
  await sql()`
    UPDATE solicitation_batches
    SET send_closed_at = NOW()
    WHERE id = ${batchId}::uuid
      AND account_id = ${accountId()}::uuid
      AND business_id = ${businessId}::uuid
  `;
}

/** An approved batch inside its veto window — the state the panel calls
 *  `haltable` and the first of the three withdrawable states. */
async function stampVetoWindowBatch(batchId: string): Promise<void> {
  await sql()`
    UPDATE solicitation_batches
    SET approved_at = NOW() - INTERVAL '2 minutes',
        approval_method = 'owner',
        approved_by_user_id = ${userId()}::uuid,
        veto_deadline_at = NOW() + INTERVAL '13 minutes'
    WHERE id = ${batchId}::uuid
      AND account_id = ${accountId()}::uuid
      AND business_id = ${businessId}::uuid
  `;
}

/** An approved batch whose veto window has elapsed and whose drip has not
 *  started — Batch state `approved`. */
async function stampApprovedBatch(batchId: string): Promise<void> {
  await sql()`
    UPDATE solicitation_batches
    SET approved_at = NOW() - INTERVAL '20 minutes',
        approval_method = 'owner',
        approved_by_user_id = ${userId()}::uuid,
        veto_deadline_at = NOW() - INTERVAL '5 minutes'
    WHERE id = ${batchId}::uuid
      AND account_id = ${accountId()}::uuid
      AND business_id = ${businessId}::uuid
  `;
}

/** An Auto-approval-lane approval (#631's shape): `approval_method='auto_policy'`,
 *  no acting user. Withdrawal must not gate on the method. */
async function stampAutoApprovedBatch(batchId: string): Promise<void> {
  await sql()`
    UPDATE solicitation_batches
    SET approved_at = NOW() - INTERVAL '2 minutes',
        approval_method = 'auto_policy',
        approved_by_user_id = NULL,
        veto_deadline_at = NOW() + INTERVAL '58 minutes'
    WHERE id = ${batchId}::uuid
      AND account_id = ${accountId()}::uuid
      AND business_id = ${businessId}::uuid
  `;
}

/** The live status/reason CHECK, as Postgres renders it. */
async function statusReasonDefinition(db: postgresType.Sql): Promise<string> {
  const [row] = await db<{ definition: string }[]>`
    SELECT pg_get_constraintdef(oid) AS definition
    FROM pg_constraint
    WHERE conname = 'solicitation_outreach_status_reason_consistency'
      AND conrelid = 'solicitation_outreach'::regclass
  `;
  return row?.definition ?? '';
}

/** 109 REPLACES 108's status/reason CHECK under the SAME NAME, so
 *  `assertSchemaReady` cannot tell them apart (see the 108 note in
 *  schema-ready.ts). The distinguishing fact is the new member, and the only
 *  honest precondition is the constraint's DEFINITION — the same technique
 *  `assertAnalyticsEventNamesRegistered` uses. It asserts the value appears
 *  EXACTLY once and inside the `cancelled` arm, so a malformed 109 that admits
 *  it under another status fails here, loudly, not in a later UPDATE. Local to
 *  this suite because it is the only writer of the value. */
async function assertOwnerWithdrawnAdmitted(db: postgresType.Sql): Promise<void> {
  const definition = await statusReasonDefinition(db);
  const occurrences = definition.split(`'owner_withdrawn'`).length - 1;
  // Postgres renders `x IN (…)` as `x = ANY (ARRAY[…])`; the cancelled arm is
  // the one whose status literal is 'cancelled'.
  const cancelledArm = /delivery_status = 'cancelled'::text\)\s*AND\s*\(disposition_reason = ANY \(ARRAY\[[^\]]*\]/.exec(
    definition,
  );
  if (occurrences === 1 && cancelledArm !== null && cancelledArm[0].includes(`'owner_withdrawn'`)) {
    return;
  }
  throw new Error(
    'test database is behind head or 109 is malformed — ' +
      `solicitation_outreach_status_reason_consistency admits 'owner_withdrawn' ${occurrences} time(s) ` +
      `(${cancelledArm === null ? 'no cancelled arm found' : 'cancelled arm: ' + cancelledArm[0]}). ` +
      'Run `pnpm test:db:setup`.',
  );
}

/**
 * Every table a withdrawal may touch, as text, so a REFUSAL can be proven to
 * have written NOTHING — not just nothing on `solicitation_outreach`.
 * postgres.js commits on a normal callback return, so a refusal that had
 * already updated the batch, an ask or a step would commit that write while
 * reporting a refusal (plan review round 1, finding 4).
 */
async function snapshotWithdrawSurface(
  batchId: string,
  parentRunId: string,
): Promise<{ batch: string; outreach: string[]; asks: string; steps: string }> {
  const [asks] = await sql()<{ snapshot: string }[]>`
    SELECT COALESCE(string_agg(a::text, '|' ORDER BY a.id), '') AS snapshot
    FROM solicitation_asks a
    WHERE a.batch_id = ${batchId}::uuid
      AND a.account_id = ${accountId()}::uuid
      AND a.business_id = ${businessId}::uuid
  `;
  const [steps] = await sql()<{ snapshot: string }[]>`
    SELECT COALESCE(string_agg(s::text, '|' ORDER BY s.step_index), '') AS snapshot
    FROM agent_run_steps s
    WHERE s.agent_run_id = ${parentRunId}::uuid
  `;
  return {
    batch: await snapshotBatch(batchId),
    outreach: await snapshotOutreach(batchId),
    asks: asks?.snapshot ?? '',
    steps: steps?.snapshot ?? '',
  };
}

/**
 * The WHOLE row as text. "Unchanged" has to mean every column, not the handful
 * a typed reader happens to select — a refused write that still touched, say,
 * `updated_at` is exactly the leak this assertion exists to catch.
 */
async function snapshotBatch(batchId: string): Promise<string> {
  const [row] = await sql()<{ snapshot: string }[]>`
    SELECT to_jsonb(b.*)::text AS snapshot
    FROM solicitation_batches b
    WHERE b.id = ${batchId}::uuid
      AND b.account_id = ${accountId()}::uuid
      AND b.business_id = ${businessId}::uuid
  `;
  return row!.snapshot;
}

async function snapshotOutreach(batchId: string): Promise<string[]> {
  const rows = await sql()<{ snapshot: string }[]>`
    SELECT to_jsonb(o.*)::text AS snapshot
    FROM solicitation_outreach o
    WHERE o.batch_id = ${batchId}::uuid
      AND o.account_id = ${accountId()}::uuid
      AND o.business_id = ${businessId}::uuid
    ORDER BY o.id
  `;
  return rows.map((row) => row.snapshot);
}

interface OutreachRow {
  id: string;
  delivery_status: string;
  disposition_reason: string | null;
}

async function readOutreach(batchId: string): Promise<OutreachRow[]> {
  return sql()<OutreachRow[]>`
    SELECT id::text AS id, delivery_status, disposition_reason
    FROM solicitation_outreach
    WHERE batch_id = ${batchId}::uuid
      AND account_id = ${accountId()}::uuid
      AND business_id = ${businessId}::uuid
    ORDER BY attempt_no, id
  `;
}

interface StepRow {
  step_key: string;
  attributed_agent: string;
  detail: unknown;
}

async function readSteps(runId: string, stepKey: string): Promise<StepRow[]> {
  return sql()<StepRow[]>`
    SELECT step_key, attributed_agent, detail
    FROM agent_run_steps
    WHERE agent_run_id = ${runId}::uuid
      AND step_key = ${stepKey}
    ORDER BY step_index
  `;
}

/** Postgres.js behind PgBouncer can hand back JSONB as a string. */
function stepDetail(row: StepRow): Record<string, unknown> {
  const parsed: unknown = typeof row.detail === 'string' ? JSON.parse(row.detail) : row.detail;
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('agent_run_steps detail is not an object');
  }
  return parsed as Record<string, unknown>;
}

interface AuditRow {
  event_type: string;
  actor_user_id: string | null;
  entity_type: string | null;
  entity_id: string | null;
  location_id: string | null;
  account_id: string;
  payload: unknown;
}

/** Every audit row this account wrote about one batch, oldest first. */
async function readAuditRows(batchId: string): Promise<AuditRow[]> {
  return sql()<AuditRow[]>`
    SELECT event_type,
           actor_user_id::text AS actor_user_id,
           entity_type,
           entity_id,
           location_id::text AS location_id,
           account_id::text AS account_id,
           payload
    FROM account_audit_log
    WHERE account_id = ${accountId()}::uuid
      AND entity_id = ${batchId}
    ORDER BY created_at, id
  `;
}

/** Postgres.js behind PgBouncer can hand back JSONB as a string. */
function auditPayload(row: AuditRow): Record<string, unknown> {
  const parsed: unknown = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload;
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('account_audit_log payload is not an object');
  }
  return parsed as Record<string, unknown>;
}

interface RecordedQuery {
  /** Static template text with every bound value elided. */
  text: string;
  /** True when the statement was issued on the TRANSACTION, not the pool. */
  onTransaction: boolean;
}

interface InstrumentedExecutor {
  executor: postgresType.Sql;
  queries: RecordedQuery[];
  /** One entry per `begin` — the exact objects a collaborator should receive. */
  transactions: postgresType.TransactionSql[];
}

/**
 * A `Proxy` over a REAL `Sql` that records every statement and, crucially, WHICH
 * receiver issued it — the base client or the transaction the writer opened.
 *
 * Why this and not "assert both rows exist": that weaker check passes for two
 * implementations the plan calls regressions. An audit written on the base
 * client commits independently of the latch, so the row exists after a rollback
 * that should have taken it. An audit written AFTER `recordStep` also leaves
 * both rows behind, while inverting the lock order (advisory -> batch row ->
 * `agent_runs`) this file's header calls an ABBA deadlock against the
 * offboarding purge. Only receiver identity plus call order separates them.
 *
 * A Proxy over a real `Sql`, never a `{ begin } as unknown as Sql` cast, and
 * every leading `begin` argument is forwarded — same contract, and the same
 * reasoning, as `helpers/abort-injection.ts`.
 */
function instrumentedExecutor(base: postgresType.Sql): InstrumentedExecutor {
  const queries: RecordedQuery[] = [];
  const transactions: postgresType.TransactionSql[] = [];

  const record = (argArray: unknown[], onTransaction: boolean): void => {
    const strings = argArray[0] as TemplateStringsArray | undefined;
    if (strings && Array.isArray(strings.raw)) {
      queries.push({ text: strings.join(' ? '), onTransaction });
    }
  };

  const bindTrap = (target: object, prop: string | symbol): unknown => {
    const value: unknown = Reflect.get(target, prop);
    return typeof value === 'function'
      ? (value as (...args: unknown[]) => unknown).bind(target)
      : value;
  };

  const wrapTransaction = (tx: postgresType.TransactionSql): postgresType.TransactionSql => {
    const proxy = new Proxy(tx, {
      apply(target, thisArg, argArray) {
        record(argArray, true);
        return Reflect.apply(target as unknown as (...args: unknown[]) => unknown, thisArg, argArray);
      },
      get: bindTrap,
    }) as postgresType.TransactionSql;
    transactions.push(proxy);
    return proxy;
  };

  const executor = new Proxy(base, {
    apply(target, thisArg, argArray) {
      record(argArray, false);
      return Reflect.apply(target as unknown as (...args: unknown[]) => unknown, thisArg, argArray);
    },
    get(target, prop) {
      if (prop !== 'begin') return bindTrap(target, prop);
      return (...args: unknown[]) => {
        const callback = args[args.length - 1] as (
          tx: postgresType.TransactionSql,
        ) => Promise<unknown>;
        const leading = args.slice(0, -1);
        return (target.begin as (...forwarded: unknown[]) => Promise<unknown>)(
          ...leading,
          (tx: postgresType.TransactionSql) => callback(wrapTransaction(tx)),
        );
      };
    },
  }) as postgresType.Sql;

  return { executor, queries, transactions };
}

// ── #1010 T5 fixtures: the Refusal ledger ───────────────────────────────────

/** The default-ON kill switch. Only the literal string 'false' disables it. */

/** Postgres' CHECK-violation SQLSTATE. */
const CHECK_VIOLATION = '23514';

interface RefusalRow {
  account_id: string;
  business_id: string | null;
  refusal_source: string;
  refusal_code: string | null;
  all_refusal_codes: string[] | null;
  refusal_category: string;
  subject_type: string | null;
  subject_id: string | null;
  occurred_at: string;
  /**
   * `occurred_at = solicitation_batches.halted_at`, settled INSIDE Postgres.
   *
   * It cannot be computed in JavaScript: postgres.js decodes `timestamptz` to a
   * JS `Date` and truncates microseconds (#520), so a halt lane that had read
   * `halted_at` back and passed it forward would compare EQUAL after truncation
   * and this claim would be unfalsifiable. `NOW()` is `transaction_timestamp()`
   * and is stable across every statement in the transaction, so the sentinel
   * produces the identical value to the microsecond.
   */
  matches_halted_at: boolean | null;
  halted_at: string | null;
}

/** Every Refusal written against ONE batch. */
async function readRefusals(batchId: string): Promise<RefusalRow[]> {
  return sql()<RefusalRow[]>`
    SELECT refusal.account_id::text AS account_id,
           refusal.business_id::text AS business_id,
           refusal.refusal_source,
           refusal.refusal_code,
           refusal.all_refusal_codes,
           refusal.refusal_category,
           refusal.subject_type,
           refusal.subject_id::text AS subject_id,
           refusal.occurred_at::text AS occurred_at,
           (refusal.occurred_at = batch.halted_at) AS matches_halted_at,
           batch.halted_at::text AS halted_at
    FROM refusal_events refusal
    LEFT JOIN solicitation_batches batch ON batch.id = refusal.subject_id
    WHERE refusal.account_id = ${accountId()}::uuid
      AND refusal.subject_id = ${batchId}::uuid
    ORDER BY refusal.occurred_at
  `;
}

/** Every Refusal this account carries, whatever it points at — the counterpart
 *  to `readRefusals` for the cases whose claim is "none, anywhere". */
async function readAllRefusals(): Promise<RefusalRow[]> {
  return sql()<RefusalRow[]>`
    SELECT refusal.account_id::text AS account_id,
           refusal.business_id::text AS business_id,
           refusal.refusal_source,
           refusal.refusal_code,
           refusal.all_refusal_codes,
           refusal.refusal_category,
           refusal.subject_type,
           refusal.subject_id::text AS subject_id,
           refusal.occurred_at::text AS occurred_at,
           (refusal.occurred_at = batch.halted_at) AS matches_halted_at,
           batch.halted_at::text AS halted_at
    FROM refusal_events refusal
    LEFT JOIN solicitation_batches batch ON batch.id = refusal.subject_id
    WHERE refusal.account_id = ${accountId()}::uuid
    ORDER BY refusal.occurred_at
  `;
}

/**
 * `latchSystemHalt` discharged exactly as the release cycle's sweeps do: one
 * transaction, the batch row locked first, then the latch. The verb takes no
 * advisory lock and there is no owner request to authorize — the row lock is
 * the caller's whole obligation.
 */
async function latchSystemHaltUnderLock(
  batchId: string,
  reason: 'send_window_elapsed' | 'batch_expired' | 'platform_halt',
): Promise<unknown> {
  return sql().begin(async (tx) => {
    await tx`
      SELECT id FROM solicitation_batches
      WHERE id = ${batchId}::uuid
        AND account_id = ${accountId()}::uuid
        AND business_id = ${businessId}::uuid
      FOR UPDATE
    `;
    return approvalModule.latchSystemHalt(tx, {
      batchId,
      accountId: accountId(),
      businessId,
      reason,
    });
  });
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

// One suite, one set of hooks: `haltBatch` and the tenant-scope case are
// nested below rather than being sibling top-level suites, because a second
// top-level suite in this file would need its own live-DB lock and its own
// copy of the upload -> contact -> batch -> ask chain — a parallel fixture path
// for no gain.
describeWithDb('solicitation approval lane', { enabled: Boolean(testDatabaseUrl), timeout: 90_000 }, () => {
  beforeAll(async () => {
    const databaseUrl = assertLocalTestDatabaseUrl(testDatabaseUrl);
    featureDatabaseLock = await acquireLiveDbLock(databaseUrl);
    db = postgres(databaseUrl, { max: 4, prepare: false });
    writerDb = postgres(databaseUrl, { max: 2, prepare: false });
    await assertSchemaReady(db, [
      MIGRATION_091_SEND_MODE_SPINE_LIFECYCLE,
      MIGRATION_108_OUTREACH_OWNER_EXCLUDED,
    ]);
    await assertOwnerWithdrawnAdmitted(db);
    tenant = await seedTenantAccount(db, {
      userName: 'Approval Owner',
      accountDisplayName: 'Approval Account',
    });
    foreignTenant = await seedTenantAccount(db, {
      userName: 'Foreign Owner',
      accountDisplayName: 'Foreign Account',
    });
    await db`
      INSERT INTO businesses (
        id, name, owner_name, owner_email, account_id,
        subscription_status, category
      ) VALUES (
        ${businessId}::uuid, 'Approval Business', 'Approval Owner',
        ${tenant.ownerEmail}, ${tenant.accountId}::uuid, 'active', 'automotive'
      )
    `;
    // `is_primary` stays FALSE: businesses_account_primary_uniq allows one
    // primary per account, and the location above already defaults to FALSE.
    await seedLocation(db, tenant.accountId, {
      businessId: siblingBusinessId,
      name: 'Approval Sibling Location',
      isPrimary: false,
    });
    // No `account_id`: a RepWorth operator is not a member of the account they
    // act on. That is the whole content of D1 and of invariant #8's carve-out
    // for the admin control plane.
    await db`
      INSERT INTO users (id, name, email, role)
      VALUES (
        ${adminUserId}::uuid, 'RepWorth Operator',
        ${`admin-${adminUserId}@test.local`}, 'admin'
      )
    `;
  }, LIVE_DB_LOCK_HOOK_TIMEOUT_MS);

  beforeEach(() => {
    // mockClear, NOT mockReset: the delegating implementations set in the
    // module factories have to survive, or every pre-existing case in this file
    // would start running against a no-op collaborator.
    for (const spy of Object.values(spies)) spy.mockClear();
  });

  afterEach(async () => {
    // The kill switch is default-ON and one case turns it off; a leak would
    // silently turn every ledger assertion in this file into a no-op that still
    // passes.
    delete process.env[REFUSAL_LEDGER_FLAG];
    // #1010's rows. Cleared per case so "exactly one Refusal" means this case's,
    // and swept BEFORE teardown deletes the account and location this table's
    // two no-action foreign keys point at.
    await sql()`DELETE FROM refusal_events WHERE account_id = ${accountId()}::uuid`;
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
    // The admin arm's durable receipt. Cleared per case so cardinality
    // assertions ("exactly one audit row") mean this case's rows.
    await sql()`DELETE FROM account_audit_log WHERE account_id = ${accountId()}::uuid`;
  }, 30_000);

  afterAll(async () => {
    try {
      if (db) {
        await db`DELETE FROM businesses WHERE id = ${businessId}::uuid`;
        await cleanupLocation(db, siblingBusinessId);
        // account_audit_log.actor_user_id is an FK with no cascade, so any
        // stranded row has to go before the operator it names.
        await db`DELETE FROM account_audit_log WHERE actor_user_id = ${adminUserId}::uuid`;
        await db`DELETE FROM users WHERE id = ${adminUserId}::uuid`;
        if (tenant) await cleanupTenantAccount(db, tenant);
        if (foreignTenant) await cleanupTenantAccount(db, foreignTenant);
      }
    } finally {
      try {
        if (writerDb) await writerDb.end({ timeout: 5 });
        if (db) await db.end({ timeout: 5 });
      } finally {
        await featureDatabaseLock?.release();
        featureDatabaseLock = undefined;
      }
    }
  }, 120_000);

  it('approves a built batch with owner method and a 15-minute veto deadline', async () => {
    const { batchId, accountId: account, businessId: business, userId: owner } =
      await seedRenderedBatch({ renders: 3 });

    const result = await approveBatch(sql(), {
      batchId,
      accountId: account,
      businessId: business,
      approvedByUserId: owner,
      excludedOutreachIds: [],
    });

    expect(result).toMatchObject({ status: 'approved', approvedCount: 3, excludedCount: 0 });
    const row = await readBatch(batchId);
    expect(row.approval_method).toBe('owner');
    expect(row.gap_minutes).toBe(15);
  });

  it('a second approval writes nothing and reports the batch as already approved', async () => {
    const { batchId, accountId: account, businessId: business, userId: owner } =
      await seedRenderedBatch({ renders: 2 });
    const call = (): Promise<unknown> =>
      approveBatch(sql(), {
        batchId,
        accountId: account,
        businessId: business,
        approvedByUserId: owner,
        excludedOutreachIds: [],
      });

    const first = await call();
    const approvedAt = (await readBatch(batchId)).approved_at;
    const second = await call();

    expect(first).toMatchObject({ status: 'approved', approvedCount: 2 });
    expect(second).toEqual({ status: 'already_approved' });
    // The CAS is what makes a double-submit inert: a second approval would
    // otherwise restamp approved_at and hand the owner a fresh veto window.
    expect((await readBatch(batchId)).approved_at).toBe(approvedAt);
  });

  it('cancels excluded asks owner_excluded in the same transaction as the approval', async () => {
    const { batchId, accountId: account, businessId: business, userId: owner, outreachIds } =
      await seedRenderedBatch({ renders: 3 });

    const result = await approveBatch(sql(), {
      batchId,
      accountId: account,
      businessId: business,
      approvedByUserId: owner,
      excludedOutreachIds: [outreachIds[0]!],
    });

    expect(result).toMatchObject({ status: 'approved', approvedCount: 2, excludedCount: 1 });
    const rows = await readOutreach(batchId);
    const excluded = rows.find((row) => row.id === outreachIds[0]!);
    expect(excluded).toMatchObject({
      delivery_status: 'cancelled',
      disposition_reason: 'owner_excluded',
    });
    expect(rows.filter((row) => row.delivery_status === 'rendered')).toHaveLength(2);
  });

  it('refuses to approve while a send ask has no outreach row', async () => {
    const {
      batchId,
      uploadId,
      accountId: account,
      businessId: business,
      userId: owner,
      parentRunId,
    } = await seedRenderedBatch({ renders: 2 });
    // A third send ask whose render has not landed yet — generation is still
    // in flight, so approving now would let it render AFTER approval.
    const bareAsk = await seedSendAsk(batchId, uploadId);
    const approve = (): Promise<unknown> =>
      approveBatch(sql(), {
        batchId,
        accountId: account,
        businessId: business,
        approvedByUserId: owner,
        excludedOutreachIds: [],
      });

    expect(await approve()).toEqual({ status: 'not_ready', missingRenders: 1 });
    expect((await readBatch(batchId)).approved_at).toBeNull();

    // Committing the missing render is the ONLY thing that changes: the gate is
    // pinned to the committed render set, not to a client-supplied count.
    await seedAttempt({ batchId, ask: bareAsk, deliveryStatus: 'rendered' });

    expect(await approve()).toMatchObject({ status: 'approved', approvedCount: 3 });
    expect(await readSteps(parentRunId, 'batch_approved')).toHaveLength(1);
  });

  it(
    'blocks approval on the batch lock until an in-flight render commits, then counts it',
    async () => {
      const {
        batchId,
        uploadId,
        accountId: account,
        businessId: business,
        userId: owner,
        parentRunId,
      } = await seedRenderedBatch({ renders: 2 });
      const thirdAsk = await seedSendAsk(batchId, uploadId);

      // A: hold the child-render transaction open, exactly as persistChildRender
      // does — advisory lock, then the insert, no commit yet.
      let signalAReady!: () => void;
      const aReady = new Promise<void>((resolve) => {
        signalAReady = resolve;
      });
      let releaseA!: () => void;
      const aHeld = new Promise<void>((resolve) => {
        releaseA = resolve;
      });
      const aDone = writerSql().begin(async (tx) => {
        await acquireSolicitationBatchLock(tx, business);
        await insertOutreachRender(tx, renderInput(batchId, thirdAsk, parentRunId));
        signalAReady();
        await aHeld; // hold the lock
      });

      let settled = false;
      let bDone: Promise<unknown> | undefined;
      try {
        // Launching B without this handshake tests nothing: whichever
        // connection reaches the advisory key first wins, and B winning
        // produces a green `settled === false` for the wrong reason.
        // Racing against `aDone` surfaces an A that died before signalling
        // instead of hanging until the suite timeout.
        await Promise.race([aReady, aDone]);

        // B: approval must BLOCK on the advisory lock, not read past it.
        bDone = approveBatch(sql(), {
          batchId,
          accountId: account,
          businessId: business,
          approvedByUserId: owner,
          excludedOutreachIds: [],
        }).then((result) => {
          settled = true;
          return result;
        });

        await new Promise((resolve) => setTimeout(resolve, 250));
        expect(settled).toBe(false); // still waiting on A
      } finally {
        releaseA();
        // Never leak the held transaction, whatever the assertion above did.
        await Promise.allSettled([aDone, bDone ?? Promise.resolve()]);
      }

      // Approval saw the COMMITTED set: three renders, none missed. A torn read
      // would have answered `not_ready` (uncommitted insert invisible) or
      // approved a count of 2 — this is the serialized-snapshot property.
      expect(await bDone).toMatchObject({ status: 'approved', approvedCount: 3 });
    },
    30_000,
  );

  it('refuses a built batch that has no send work at all', async () => {
    // Every candidate withheld at decision time, so the builder skipped the
    // generation enqueue and no send parent exists. Readiness cannot catch this
    // — its anti-join counts `status = 'send'` asks and passes VACUOUSLY over
    // zero of them — so this batch reaches the approval CAS on the strength of
    // having nothing to check.
    const { batchId, uploadId } = await seedBatch('1 hour');
    await seedWithholdAsk(batchId, uploadId);
    const before = await snapshotBatch(batchId);

    const result = await approveBatch(sql(), {
      batchId,
      accountId: accountId(),
      businessId,
      approvedByUserId: userId(),
      excludedOutreachIds: [],
    });

    // A refusal the route maps to 409, NOT the 500 a missing-parent throw would
    // have raised: approving would stamp a batch that can never send and — with
    // no parent for closeBatchIfSettled to terminalize — can never close, while
    // holding the location's one active-send slot against its next real batch.
    expect(result).toEqual({
      status: 'not_approvable',
      state: 'built',
      reason: 'no_send_parent',
    });
    expect(await snapshotBatch(batchId)).toBe(before);
  });

  it('refuses to approve a batch past its 7-day approval window', async () => {
    const { batchId, accountId: account, businessId: business, userId: owner } =
      await seedRenderedBatch({ renders: 1, builtAgo: '8 days' });

    const result = await approveBatch(sql(), {
      batchId,
      accountId: account,
      businessId: business,
      approvedByUserId: owner,
      excludedOutreachIds: [],
    });

    expect(result).toEqual({ status: 'not_approvable', state: 'expired' });
    expect((await readBatch(batchId)).approved_at).toBeNull();
  });

  it('excluding every ask closes the batch and terminalizes the send parent completed', async () => {
    const {
      batchId,
      accountId: account,
      businessId: business,
      userId: owner,
      parentRunId,
      outreachIds,
    } = await seedRenderedBatch({ renders: 3 });

    const result = await approveBatch(sql(), {
      batchId,
      accountId: account,
      businessId: business,
      approvedByUserId: owner,
      excludedOutreachIds: outreachIds,
    });

    expect(result).toMatchObject({
      status: 'approved',
      approvedCount: 0,
      excludedCount: 3,
      close: { status: 'closed', disposition: 'exhausted', parentStatus: 'completed' },
    });
    expect((await readBatch(batchId)).send_closed_at).not.toBeNull();
    expect(await readRunStatus(parentRunId)).toBe('completed');

    // The disposition is what distinguishes a correct close from a
    // coincidentally-correct parent status: `cancelled` and `expired` both
    // terminalize somewhere, and only one of them is right here.
    const closeSteps = await readSteps(parentRunId, 'send_batch_closed');
    expect(closeSteps).toHaveLength(1);
    expect(stepDetail(closeSteps[0]!)).toMatchObject({ disposition: 'exhausted', cancelled: 3 });
  });

  it('records the approval as a step on the send batch parent', async () => {
    const { batchId, accountId: account, businessId: business, userId: owner, parentRunId } =
      await seedRenderedBatch({ renders: 3 });

    await approveBatch(sql(), {
      batchId,
      accountId: account,
      businessId: business,
      approvedByUserId: owner,
      excludedOutreachIds: [],
    });

    const steps = await readSteps(parentRunId, 'batch_approved');
    expect(steps).toHaveLength(1);
    expect(steps[0]!.attributed_agent).toBe('solicitation');
    expect(stepDetail(steps[0]!)).toMatchObject({
      approval_method: 'owner',
      approved_by_user_id: owner,
      approved_count: 3,
      excluded_count: 0,
      veto_window_minutes: 15,
    });
  });

  it('refuses a stale exclusion list without cancelling any row or approving the batch', async () => {
    const {
      batchId,
      uploadId,
      accountId: account,
      businessId: business,
      userId: owner,
      outreachIds,
    } = await seedRenderedBatch({ renders: 2 });
    // A withheld row is a FINISHED attempt: it satisfies readiness but is not
    // approvable copy, so its id is not a live rendered row of this batch.
    const withheldAsk = await seedSendAsk(batchId, uploadId);
    const withheldId = await seedAttempt({
      batchId,
      ask: withheldAsk,
      deliveryStatus: 'withheld',
      dispositionReason: 'lint_failed',
    });

    const result = await approveBatch(sql(), {
      batchId,
      accountId: account,
      businessId: business,
      approvedByUserId: owner,
      excludedOutreachIds: [outreachIds[0]!, withheldId],
    });

    // Validate-then-mutate: postgres.js commits when the callback resolves, so
    // a validate-AFTER-write implementation would have committed the valid
    // row's cancellation while reporting the approval refused.
    expect(result).toEqual({ status: 'unknown_exclusion' });
    expect((await readBatch(batchId)).approved_at).toBeNull();
    const rows = await readOutreach(batchId);
    expect(rows.find((row) => row.id === outreachIds[0]!)!.delivery_status).toBe('rendered');
    expect(rows.find((row) => row.id === withheldId)!.delivery_status).toBe('withheld');
  });

  it('approves the rendered subset when another send ask is withheld', async () => {
    const { batchId, uploadId, accountId: account, businessId: business, userId: owner } =
      await seedRenderedBatch({ renders: 1 });
    const withheldAsk = await seedSendAsk(batchId, uploadId);
    const withheldId = await seedAttempt({
      batchId,
      ask: withheldAsk,
      deliveryStatus: 'withheld',
      dispositionReason: 'lint_failed',
    });

    const result = await approveBatch(sql(), {
      batchId,
      accountId: account,
      businessId: business,
      approvedByUserId: owner,
      excludedOutreachIds: [],
    });

    // Readiness is "non-cancelled", not "rendered" — requiring `rendered` would
    // wedge every batch that had one lint failure.
    expect(result).toMatchObject({ status: 'approved', approvedCount: 1, excludedCount: 0 });
    const withheld = (await readOutreach(batchId)).find((row) => row.id === withheldId);
    expect(withheld).toMatchObject({
      delivery_status: 'withheld',
      disposition_reason: 'lint_failed',
    });
  });

  it('treats a superseded attempt as ready only once its replacement exists', async () => {
    const { batchId, uploadId, accountId: account, businessId: business, userId: owner } =
      await seedRenderedBatch({ renders: 1 });
    // A cancelled attempt is the ONE status that leaves a hole: its replacement
    // has not been written yet, so the ask still owes a render.
    const supersededAsk = await seedSendAsk(batchId, uploadId);
    await seedAttempt({
      batchId,
      ask: supersededAsk,
      deliveryStatus: 'cancelled',
      dispositionReason: 'superseded',
      attemptNo: 1,
    });
    const approve = (): Promise<unknown> =>
      approveBatch(sql(), {
        batchId,
        accountId: account,
        businessId: business,
        approvedByUserId: owner,
        excludedOutreachIds: [],
      });

    expect(await approve()).toEqual({ status: 'not_ready', missingRenders: 1 });

    const replacementId = await seedAttempt({
      batchId,
      ask: supersededAsk,
      deliveryStatus: 'rendered',
      attemptNo: 2,
    });

    expect(await approve()).toMatchObject({ status: 'approved', approvedCount: 2 });
    const rendered = (await readOutreach(batchId))
      .filter((row) => row.delivery_status === 'rendered')
      .map((row) => row.id);
    expect(rendered).toContain(replacementId);
  });

  describe('haltBatch', () => {
    it('halt latches once and a second halt writes nothing', async () => {
      const { batchId, accountId: account, businessId: business, userId: owner, parentRunId } =
        await seedRenderedBatch({ renders: 2 });
      const halt = (): Promise<unknown> =>
        haltBatch(sql(), {
          batchId,
          accountId: account,
          businessId: business,
          haltedByUserId: owner,
        });

      const first = await halt();
      const latchedAt = (await readHalt(batchId)).halted_at;
      const second = await halt();

      // Cancelling both live rows settles the batch, so the halt closes it in
      // the same transaction and terminalizes the parent `cancelled`.
      expect(first).toMatchObject({
        status: 'halted',
        reason: 'owner_veto',
        cancelledCount: 2,
        close: { status: 'closed', disposition: 'halted', parentStatus: 'cancelled' },
      });
      expect(second).toEqual({ status: 'already_halted' });
      // Monotone: the CAS on `halted_at IS NULL` is what makes the second call
      // inert. Without it the latch would restamp and the audit trail would
      // record the wrong instant — and a second receipt would appear.
      expect(latchedAt).not.toBeNull();
      expect((await readHalt(batchId)).halted_at).toBe(latchedAt);
      expect(await readSteps(parentRunId, 'batch_halted')).toHaveLength(1);
    });

    it('halt cancels rendered and queued rows and never a sending row', async () => {
      const { batchId, uploadId, accountId: account, businessId: business, userId: owner } =
        await seedRenderedBatch({ renders: 1 });
      const queuedAsk = await seedSendAsk(batchId, uploadId);
      const queuedId = await seedAttempt({ batchId, ask: queuedAsk, deliveryStatus: 'queued' });
      const sendingAsk = await seedSendAsk(batchId, uploadId);
      const sendingId = await seedAttempt({ batchId, ask: sendingAsk, deliveryStatus: 'sending' });
      await stampSendingBatch(batchId);

      const result = await haltBatch(sql(), {
        batchId,
        accountId: account,
        businessId: business,
        haltedByUserId: owner,
      });

      expect(result).toMatchObject({
        status: 'halted',
        reason: 'owner_halt',
        cancelledCount: 2,
        // The in-flight row is still live, so the halt does NOT close the batch
        // — the row that resolves itself is the one that will close it.
        close: { status: 'not_settled', liveCount: 1 },
      });
      const rows = await readOutreach(batchId);
      expect(rows.find((row) => row.id === queuedId)).toMatchObject({
        delivery_status: 'cancelled',
        disposition_reason: 'owner_halt',
      });
      // `sending` is past the point of no return: halt means "no further
      // sends", not "undo a dispatch the provider may already have accepted".
      expect(rows.find((row) => row.id === sendingId)).toMatchObject({
        delivery_status: 'sending',
        disposition_reason: null,
      });
    });

    it('halt before sending starts records owner_veto and after it records owner_halt', async () => {
      const built = await seedRenderedBatch({ renders: 1 });
      const sending = await seedRenderedBatch({ renders: 1 });
      // Only the second batch is approved, so the two never contend for
      // solicitation_batches_one_active_send_per_business.
      await stampSendingBatch(sending.batchId);

      const veto = await haltBatch(sql(), {
        batchId: built.batchId,
        accountId: built.accountId,
        businessId: built.businessId,
        haltedByUserId: built.userId,
      });
      const halt = await haltBatch(sql(), {
        batchId: sending.batchId,
        accountId: sending.accountId,
        businessId: sending.businessId,
        haltedByUserId: sending.userId,
      });

      expect(veto).toMatchObject({ status: 'halted', reason: 'owner_veto' });
      expect(halt).toMatchObject({ status: 'halted', reason: 'owner_halt' });
      // Asserted on the ROW, not just the result: the reason is derived from
      // the batch state server-side and persisted, so a client that could name
      // its own reason could file a mid-drip halt as a veto and make the audit
      // trail lie about whether email had left.
      expect(await readHalt(built.batchId)).toMatchObject({
        halt_reason: 'owner_veto',
        halted_by: built.userId,
      });
      expect(await readHalt(sending.batchId)).toMatchObject({
        halt_reason: 'owner_halt',
        halted_by: sending.userId,
      });
    });

    it('refuses to halt a batch that is already closed', async () => {
      // A batch whose only ask was withheld: settled with nothing sent, then
      // closed. Closure without approval is legal (091's carve-out).
      const { batchId, uploadId } = await seedBatch('1 hour');
      await seedSendParent(batchId);
      const ask = await seedSendAsk(batchId, uploadId);
      await seedAttempt({
        batchId,
        ask,
        deliveryStatus: 'withheld',
        dispositionReason: 'lint_failed',
      });
      await stampClosedBatch(batchId);

      const result = await haltBatch(sql(), {
        batchId,
        accountId: accountId(),
        businessId,
        haltedByUserId: userId(),
      });

      // Closed is terminal — there is nothing left to stop, and latching over
      // it would rewrite the disposition of a batch that already reported.
      expect(result).toEqual({ status: 'not_haltable', state: 'closed' });
      expect((await readHalt(batchId)).halted_at).toBeNull();
    });

    it('halts a built batch that was never approved', async () => {
      // No send parent on purpose: generation can die before minting one, and
      // the owner discarding a built batch must still route through the latch.
      const { batchId, uploadId } = await seedBatch('2 hours');
      const ask = await seedSendAsk(batchId, uploadId);
      await seedAttempt({ batchId, ask, deliveryStatus: 'rendered' });

      const result = await haltBatch(sql(), {
        batchId,
        accountId: accountId(),
        businessId,
        haltedByUserId: userId(),
      });

      // `no_send_parent` rather than a throw: the join has no run to
      // terminalize and must leave the batch alone, not fail the halt.
      expect(result).toMatchObject({
        status: 'halted',
        reason: 'owner_veto',
        cancelledCount: 1,
        close: { status: 'no_send_parent' },
      });
      expect(await readHalt(batchId)).toMatchObject({
        halt_reason: 'owner_veto',
        halted_by: userId(),
      });
      expect((await readBatch(batchId)).approved_at).toBeNull();
    });

    it('haltBatch returns not_haltable for an unbuilt pending batch and leaves the builder able to stamp built_at', async () => {
      // Branch review round 1, F2. This guard shipped admin-only, deferred on
      // the argument that the owner hole needed a stop control on a building
      // batch. The premise was false: `readLatestBatch` returns the pending
      // batch's id to the authenticated owner, and the owner halt route accepts
      // any valid id from its body — so an owner could GET the id, POST it, and
      // latch a batch the builder had not finished. A React button being absent
      // is not a server-side lifecycle invariant. See deviations D9.
      const batchId = await seedUnbuiltBatch();
      const before = await snapshotBatch(batchId);

      const result = await haltBatch(sql(), {
        batchId,
        accountId: accountId(),
        businessId,
        haltedByUserId: userId(),
      });

      expect(result).toEqual({ status: 'not_haltable', state: 'pending' });
      expect(await snapshotBatch(batchId)).toBe(before);

      // The consequence, asserted rather than described: the builder's own CAS
      // still succeeds. 091:176 is `(halted_at IS NULL OR built_at IS NULL OR
      // halted_at >= built_at)`, so a latch here would pass at halt time and
      // make THIS statement throw instead — inside batch-builder, far from the
      // route that caused it.
      const stamped = await sql()`
        UPDATE solicitation_batches
        SET built_at = NOW()
        WHERE id = ${batchId}::uuid
          AND account_id = ${accountId()}::uuid
          AND business_id = ${businessId}::uuid
          AND built_at IS NULL
        RETURNING id
      `;
      expect(stamped.count).toBe(1);
    });
  });

  describe('withdrawAsk', () => {
    function withdraw(
      batch: RenderedBatch,
      askId: string,
      overrides: Partial<{ accountId: string; businessId: string; batchId: string }> = {},
    ) {
      return withdrawAsk(sql(), {
        batchId: overrides.batchId ?? batch.batchId,
        askId,
        accountId: overrides.accountId ?? batch.accountId,
        businessId: overrides.businessId ?? batch.businessId,
        withdrawnByUserId: batch.userId,
      });
    }

    it('withdraws one rendered ask owner_withdrawn in the same transaction and records ask_withdrawn on the send parent', async () => {
      const batch = await seedRenderedBatch({ renders: 3 });
      await stampVetoWindowBatch(batch.batchId);
      const target = batch.asks[0]!;

      const result = await withdraw(batch, target.askId);

      expect(result).toMatchObject({
        status: 'withdrawn',
        remainingLive: 2,
        close: { status: 'not_settled', liveCount: 2 },
      });
      const rows = await readOutreach(batch.batchId);
      expect(rows.find((row) => row.id === batch.outreachIds[0])).toMatchObject({
        delivery_status: 'cancelled',
        disposition_reason: 'owner_withdrawn',
      });
      // The two untouched rows are still live — one row, not the cohort.
      expect(rows.filter((row) => row.delivery_status === 'rendered')).toHaveLength(2);

      const steps = await readSteps(batch.parentRunId, 'ask_withdrawn');
      expect(steps).toHaveLength(1);
      expect(stepDetail(steps[0]!)).toMatchObject({
        ask_id: target.askId,
        outreach_id: batch.outreachIds[0],
        withdrawn_by: batch.userId,
        delivery_status_before: 'rendered',
        remaining_live: 2,
        state_at_withdrawal: 'veto_window',
      });
      // The batch is still approved and its veto clock untouched: no per-ask
      // approval state, no re-minted deadline (ADR 0021 property 2).
      const after = await readBatch(batch.batchId);
      expect(after.approved_at).not.toBeNull();
      expect(after.gap_minutes).toBe(15);
      expect(after.send_closed_at).toBeNull();
    });

    it('withdrawal is legal in veto_window, approved and sending and refused in built, halted and closed', async () => {
      // Three separate batches so the one-active-send index never contends.
      const inVeto = await seedRenderedBatch({ renders: 1 });
      await stampVetoWindowBatch(inVeto.batchId);
      const halted = await seedRenderedBatch({ renders: 1 });
      const built = await seedRenderedBatch({ renders: 1 });
      const closed = await seedRenderedBatch({ renders: 1 });
      await stampClosedBatch(closed.batchId);
      // Past the 7-day approval window and never approved: `expired`.
      const expired = await seedRenderedBatch({ renders: 1, builtAgo: '8 days' });
      const refusedBefore = {
        built: await snapshotWithdrawSurface(built.batchId, built.parentRunId),
        closed: await snapshotWithdrawSurface(closed.batchId, closed.parentRunId),
        expired: await snapshotWithdrawSurface(expired.batchId, expired.parentRunId),
      };

      expect(await withdraw(inVeto, inVeto.asks[0]!.askId)).toMatchObject({ status: 'withdrawn' });
      // The veto batch is now settled (its only row is gone), so a second
      // batch may take the active-send slot for the `approved` case.
      const approved = await seedRenderedBatch({ renders: 1 });
      await stampApprovedBatch(approved.batchId);
      expect(await withdraw(approved, approved.asks[0]!.askId)).toMatchObject({ status: 'withdrawn' });
      const sending = await seedRenderedBatch({ renders: 1 });
      await stampSendingBatch(sending.batchId);
      expect(await withdraw(sending, sending.asks[0]!.askId)).toMatchObject({ status: 'withdrawn' });

      // Halt the `halted` fixture through the real latch, then probe it.
      await haltBatch(sql(), {
        batchId: halted.batchId,
        accountId: halted.accountId,
        businessId: halted.businessId,
        haltedByUserId: halted.userId,
      });
      // Snapshot AFTER the halt so the refusal below is judged against the
      // latched, settled state the halt left behind.
      const haltedBefore = await snapshotWithdrawSurface(halted.batchId, halted.parentRunId);
      expect(await withdraw(halted, halted.asks[0]!.askId)).toEqual({
        status: 'not_withdrawable',
        state: 'halted',
      });
      expect(await snapshotWithdrawSurface(halted.batchId, halted.parentRunId)).toEqual(haltedBefore);
      expect(await withdraw(built, built.asks[0]!.askId)).toEqual({
        status: 'not_withdrawable',
        state: 'built',
      });
      expect(await withdraw(closed, closed.asks[0]!.askId)).toEqual({
        status: 'not_withdrawable',
        state: 'closed',
      });
      expect(await withdraw(expired, expired.asks[0]!.askId)).toEqual({
        status: 'not_withdrawable',
        state: 'expired',
      });
      // A refusal writes NOTHING — batch, outreach, asks and steps alike.
      expect(await snapshotWithdrawSurface(built.batchId, built.parentRunId)).toEqual(refusedBefore.built);
      expect(await snapshotWithdrawSurface(closed.batchId, closed.parentRunId)).toEqual(refusedBefore.closed);
      expect(await snapshotWithdrawSurface(expired.batchId, expired.parentRunId)).toEqual(refusedBefore.expired);
    });

    it('withdraws a queued current attempt in an approved batch', async () => {
      const batch = await seedRenderedBatch({ renders: 1 });
      const queuedAsk = await seedSendAsk(batch.batchId, batch.uploadId);
      const queuedId = await seedAttempt({ batchId: batch.batchId, ask: queuedAsk, deliveryStatus: 'queued' });
      await stampSendingBatch(batch.batchId);

      const result = await withdraw(batch, queuedAsk.askId);

      // `queued` is dispatched-but-not-sending: halt cancels it, so withdrawal
      // does too — the same predicate, one row.
      expect(result).toMatchObject({ status: 'withdrawn', remainingLive: 1 });
      expect((await readOutreach(batch.batchId)).find((row) => row.id === queuedId)).toMatchObject({
        delivery_status: 'cancelled',
        disposition_reason: 'owner_withdrawn',
      });
      expect(await readSteps(batch.parentRunId, 'ask_withdrawn')).toHaveLength(1);
    });

    it('never withdraws a sending row and reports it not_live', async () => {
      const batch = await seedRenderedBatch({ renders: 1 });
      const sendingAsk = await seedSendAsk(batch.batchId, batch.uploadId);
      const sendingId = await seedAttempt({
        batchId: batch.batchId,
        ask: sendingAsk,
        deliveryStatus: 'sending',
      });
      await stampSendingBatch(batch.batchId);
      const before = await snapshotWithdrawSurface(batch.batchId, batch.parentRunId);

      const result = await withdraw(batch, sendingAsk.askId);

      // Past the point of no return: halt's "no further sends, not undo"
      // contract, inherited whole.
      expect(result).toEqual({ status: 'not_live', deliveryStatus: 'sending' });
      expect(await snapshotWithdrawSurface(batch.batchId, batch.parentRunId)).toEqual(before);
      expect((await readOutreach(batch.batchId)).find((row) => row.id === sendingId)).toMatchObject({
        delivery_status: 'sending',
      });
    });

    it('withdrawing the last waiting row does not settle while another outreach row is sending', async () => {
      const batch = await seedRenderedBatch({ renders: 1 });
      const sendingAsk = await seedSendAsk(batch.batchId, batch.uploadId);
      await seedAttempt({ batchId: batch.batchId, ask: sendingAsk, deliveryStatus: 'sending' });
      await stampSendingBatch(batch.batchId);

      const result = await withdraw(batch, batch.asks[0]!.askId);

      // The in-flight row keeps the batch open: `remainingLive` counts it, and
      // the join reports `not_settled` — the row that resolves itself is the
      // one that will close the batch.
      expect(result).toMatchObject({
        status: 'withdrawn',
        remainingLive: 1,
        close: { status: 'not_settled', liveCount: 1 },
      });
      expect((await readBatch(batch.batchId)).send_closed_at).toBeNull();
      expect(await readRunStatus(batch.parentRunId)).toBe('running');
    });

    it('withdrawal selects the highest attempt_no and never an older superseded attempt', async () => {
      const batch = await seedRenderedBatch({ renders: 1 });
      const ask = batch.asks[0]!;
      const olderId = batch.outreachIds[0]!;
      // The render lane's regenerate shape: the old row is `cancelled`/`superseded`,
      // the replacement is attempt 2 and live.
      await sql()`
        UPDATE solicitation_outreach
        SET delivery_status = 'cancelled', disposition_reason = 'superseded', updated_at = NOW()
        WHERE id = ${olderId}::uuid
          AND account_id = ${batch.accountId}::uuid
          AND business_id = ${batch.businessId}::uuid
      `;
      const newerId = await seedAttempt({ batchId: batch.batchId, ask, deliveryStatus: 'rendered', attemptNo: 2 });
      await stampVetoWindowBatch(batch.batchId);

      const result = await withdraw(batch, ask.askId);

      expect(result).toMatchObject({ status: 'withdrawn' });
      const rows = await readOutreach(batch.batchId);
      // Only the CURRENT attempt changes; the superseded one keeps its own reason.
      expect(rows.find((row) => row.id === newerId)).toMatchObject({
        delivery_status: 'cancelled',
        disposition_reason: 'owner_withdrawn',
      });
      expect(rows.find((row) => row.id === olderId)).toMatchObject({
        delivery_status: 'cancelled',
        disposition_reason: 'superseded',
      });
    });

    it('an ask in the owned batch with no outreach attempt is not_live with null status and writes nothing', async () => {
      const batch = await seedRenderedBatch({ renders: 1 });
      // A second send Ask that generation never rendered — no attempt row at all.
      const bare = await seedSendAsk(batch.batchId, batch.uploadId);
      await stampVetoWindowBatch(batch.batchId);
      const before = await snapshotWithdrawSurface(batch.batchId, batch.parentRunId);

      const result = await withdraw(batch, bare.askId);

      // Told apart from `not_found`: the ask IS in this batch, it just has
      // nothing to withdraw — and the LEFT JOIN must not fall back to another
      // ask's row.
      expect(result).toEqual({ status: 'not_live', deliveryStatus: null });
      expect(await snapshotWithdrawSurface(batch.batchId, batch.parentRunId)).toEqual(before);
    });

    it('withdrawing the last live ask closes the batch exhausted and terminalizes the send parent completed', async () => {
      const batch = await seedRenderedBatch({ renders: 1 });
      await stampVetoWindowBatch(batch.batchId);

      const result = await withdraw(batch, batch.asks[0]!.askId);

      // Same close as excluding every ask at approval: `exhausted`, parent
      // `completed`, and the join ran in THIS transaction (no separate call).
      expect(result).toMatchObject({
        status: 'withdrawn',
        remainingLive: 0,
        close: { status: 'closed', disposition: 'exhausted', parentStatus: 'completed' },
      });
      expect((await readBatch(batch.batchId)).send_closed_at).not.toBeNull();
      expect(await readRunStatus(batch.parentRunId)).toBe('completed');
      expect(await readSteps(batch.parentRunId, 'send_batch_closed')).toHaveLength(1);
    });

    it('a second withdrawal of the same ask is a no-op already_withdrawn that writes nothing', async () => {
      const batch = await seedRenderedBatch({ renders: 2 });
      await stampVetoWindowBatch(batch.batchId);
      const askId = batch.asks[0]!.askId;

      const first = await withdraw(batch, askId);
      const afterFirst = await snapshotWithdrawSurface(batch.batchId, batch.parentRunId);
      const second = await withdraw(batch, askId);

      expect(first).toMatchObject({ status: 'withdrawn' });
      expect(second).toEqual({ status: 'already_withdrawn' });
      // Idempotent means no observable second effect on ANY table — one step,
      // not two, and nothing on the batch, the asks or the outreach rows.
      expect(await snapshotWithdrawSurface(batch.batchId, batch.parentRunId)).toEqual(afterFirst);
      expect(await readSteps(batch.parentRunId, 'ask_withdrawn')).toHaveLength(1);
    });

    it('a second withdrawal after the first withdrawal settled the batch is already_withdrawn and writes nothing', async () => {
      const batch = await seedRenderedBatch({ renders: 1 });
      await stampVetoWindowBatch(batch.batchId);
      const askId = batch.asks[0]!.askId;

      const first = await withdraw(batch, askId);
      const afterFirst = await snapshotWithdrawSurface(batch.batchId, batch.parentRunId);
      const second = await withdraw(batch, askId);

      // The first withdrawal CLOSED the batch (last live row). The retry
      // arrives in Batch state `closed` and must still read as already
      // withdrawn — a fact about the row that outranks the state gate — not
      // as a 409 `not_withdrawable` (plan review round 2, finding 1).
      expect(first).toMatchObject({ status: 'withdrawn', close: { status: 'closed' } });
      expect(second).toEqual({ status: 'already_withdrawn' });
      expect(await snapshotWithdrawSurface(batch.batchId, batch.parentRunId)).toEqual(afterFirst);
    });

    it('an ask from another batch or tenant is not_found and nothing is written', async () => {
      const mine = await seedRenderedBatch({ renders: 1 });
      await stampVetoWindowBatch(mine.batchId);
      const other = await seedRenderedBatch({ renders: 1 });
      const foreign = foreignTenantSeed();
      const mineBefore = await snapshotWithdrawSurface(mine.batchId, mine.parentRunId);
      const otherBefore = await snapshotWithdrawSurface(other.batchId, other.parentRunId);

      // Right batch, an ask that lives in ANOTHER batch of the same tenant.
      const crossBatch = await withdraw(mine, other.asks[0]!.askId);
      // Right batch and ask, wrong account key (`TenantSeed` carries the
      // account only; the batch's own business id with a foreign account is
      // exactly the mismatch the composite scope must refuse).
      const crossTenant = await withdraw(mine, mine.asks[0]!.askId, {
        accountId: foreign.accountId,
      });
      // Right owner, reaching for a batch under their OTHER location.
      const siblingLocation = await withdraw(mine, mine.asks[0]!.askId, {
        businessId: siblingBusinessId,
      });
      // An id that exists nowhere.
      const unknown = await withdraw(mine, randomUUID());

      // All four are the SAME public result — a probe cannot tell a foreign
      // account, another location, an other-batch ask or an unknown id apart.
      // The two boundaries are this suite's `tenant scope` precedent: the
      // foreign ACCOUNT against an owned batch, and the right owner reaching
      // for their OTHER location; the ask-key mismatch is `crossBatch`. (No
      // foreign batch is seeded — the suite's helpers are bound to the main
      // tenant, and a foreign ask id takes `crossBatch`'s path by construction:
      // the read is keyed on batch + both tenant keys.)
      for (const result of [crossBatch, crossTenant, siblingLocation, unknown]) {
        expect(result).toEqual({ status: 'not_found' });
      }
      // Both OWNED batches untouched on every table.
      expect(await snapshotWithdrawSurface(mine.batchId, mine.parentRunId)).toEqual(mineBefore);
      expect(await snapshotWithdrawSurface(other.batchId, other.parentRunId)).toEqual(otherBefore);
    });

    it('a withheld current attempt is not_live and nothing is written', async () => {
      const batch = await seedRenderedBatch({ renders: 1 });
      const heldAsk = await seedSendAsk(batch.batchId, batch.uploadId);
      await seedAttempt({
        batchId: batch.batchId,
        ask: heldAsk,
        deliveryStatus: 'withheld',
        dispositionReason: 'lint_failed',
      });
      // A cancelled-for-another-reason attempt (a superseded row with no
      // live replacement) is also not withdrawable — and NOT idempotent-ok:
      // only `owner_withdrawn` says "already withdrawn".
      const supersededAsk = await seedSendAsk(batch.batchId, batch.uploadId);
      await seedAttempt({
        batchId: batch.batchId,
        ask: supersededAsk,
        deliveryStatus: 'cancelled',
        dispositionReason: 'superseded',
      });
      await stampVetoWindowBatch(batch.batchId);
      const before = await snapshotWithdrawSurface(batch.batchId, batch.parentRunId);

      const held = await withdraw(batch, heldAsk.askId);
      const superseded = await withdraw(batch, supersededAsk.askId);

      expect(held).toEqual({ status: 'not_live', deliveryStatus: 'withheld' });
      expect(superseded).toEqual({ status: 'not_live', deliveryStatus: 'cancelled' });
      expect(await snapshotWithdrawSurface(batch.batchId, batch.parentRunId)).toEqual(before);
    });

    it('withdrawal rolls back the outreach cancellation and the ask_withdrawn step when its transaction aborts', async () => {
      const batch = await seedRenderedBatch({ renders: 1 });
      await stampVetoWindowBatch(batch.batchId);
      const before = await snapshotWithdrawSurface(batch.batchId, batch.parentRunId);
      // The poison must be a REAL Postgres error raised on the same tx AFTER
      // the writer's work (see abort-injection.ts): division by zero, 22012.
      const aborting = abortingExecutor(sql(), (tx) => tx`SELECT 1 / 0`);

      await expect(
        withdrawAsk(aborting, {
          batchId: batch.batchId,
          askId: batch.asks[0]!.askId,
          accountId: batch.accountId,
          businessId: batch.businessId,
          withdrawnByUserId: batch.userId,
        }),
      ).rejects.toMatchObject({ code: '22012' });

      // Cancellation, step AND the last-row close all disappear together —
      // proof that every write went through the ONE transaction handle.
      expect(await snapshotWithdrawSurface(batch.batchId, batch.parentRunId)).toEqual(before);
      expect((await readBatch(batch.batchId)).send_closed_at).toBeNull();
      expect(await readRunStatus(batch.parentRunId)).toBe('running');
    });

    it('auto_policy-approved batches allow the same withdrawal as owner-approved batches', async () => {
      const batch = await seedRenderedBatch({ renders: 2 });
      await stampAutoApprovedBatch(batch.batchId);

      const result = await withdraw(batch, batch.asks[0]!.askId);

      // No `approval_method` gate: withdrawal keys on Batch state, as halt does.
      expect(result).toMatchObject({ status: 'withdrawn', remainingLive: 1 });
      const after = await readBatch(batch.batchId);
      expect(after.approval_method).toBe('auto_policy');
      expect(after.approved_by_user_id).toBeNull();
    });

    it('withdrawal never touches solicitation_asks or the batch approval columns', async () => {
      const batch = await seedRenderedBatch({ renders: 2 });
      await stampVetoWindowBatch(batch.batchId);
      const asksBefore = await sql()<{ id: string; status: string; decided_at: string }[]>`
        SELECT id::text AS id, status, decided_at::text AS decided_at
        FROM solicitation_asks
        WHERE batch_id = ${batch.batchId}::uuid
          AND account_id = ${batch.accountId}::uuid
          AND business_id = ${batch.businessId}::uuid
        ORDER BY id
      `;
      const batchBefore = await readBatch(batch.batchId);

      await withdraw(batch, batch.asks[0]!.askId);

      const asksAfter = await sql()<{ id: string; status: string; decided_at: string }[]>`
        SELECT id::text AS id, status, decided_at::text AS decided_at
        FROM solicitation_asks
        WHERE batch_id = ${batch.batchId}::uuid
          AND account_id = ${batch.accountId}::uuid
          AND business_id = ${batch.businessId}::uuid
        ORDER BY id
      `;
      // The contact is NOT released: the ask keeps status='send' (090 welds
      // it), so a rebuild still sees it as a prior send — one contact's cost,
      // by design (ADR 0021).
      expect(asksAfter).toEqual(asksBefore);
      // The approval quartet, byte for byte: no per-ask approval state, no
      // re-minted deadline (ADR 0021 property 2).
      const batchAfter = await readBatch(batch.batchId);
      expect(batchAfter).toEqual(batchBefore);
      expect(batchAfter.approved_at).not.toBeNull();
      expect(batchAfter.approved_by_user_id).toBe(batch.userId);
      expect(batchAfter.veto_deadline_at).not.toBeNull();
    });

    it('the status reason CHECK admits owner_withdrawn only under cancelled', async () => {
      const batch = await seedRenderedBatch({ renders: 1 });
      const outreachId = batch.outreachIds[0]!;

      // 109 is 108 plus exactly one value, in the cancelled arm: every 108
      // member is still admitted, and the new one appears once, there.
      const definition = await statusReasonDefinition(sql());
      for (const kept of [
        'moderation_high', 'render_failed', 'lint_failed', 'no_consent', 'suppressed', 'unsubscribed',
        'owner_veto', 'owner_halt', 'admin_halt', 'owner_excluded', 'batch_expired',
        'send_window_elapsed', 'superseded', 'send_failed', 'send_exhausted', 'send_indeterminate',
      ]) {
        expect(definition).toContain(`'${kept}'`);
      }
      expect(definition.split(`'owner_withdrawn'`).length - 1).toBe(1);
      const cancelledArm = /delivery_status = 'cancelled'::text\)\s*AND\s*\(disposition_reason = ANY \(ARRAY\[[^\]]*\]/.exec(
        definition,
      );
      expect(cancelledArm?.[0]).toContain(`'owner_withdrawn'`);

      // Legal pairing: cancelled + owner_withdrawn.
      await expect(
        sql()`
          UPDATE solicitation_outreach
          SET delivery_status = 'cancelled', disposition_reason = 'owner_withdrawn'
          WHERE id = ${outreachId}::uuid
            AND account_id = ${batch.accountId}::uuid
            AND business_id = ${batch.businessId}::uuid
        `,
      ).resolves.toBeDefined();
      // Illegal pairing: a live status may carry no reason at all.
      await expect(
        sql()`
          UPDATE solicitation_outreach
          SET delivery_status = 'rendered', disposition_reason = 'owner_withdrawn'
          WHERE id = ${outreachId}::uuid
            AND account_id = ${batch.accountId}::uuid
            AND business_id = ${batch.businessId}::uuid
        `,
      ).rejects.toMatchObject({ code: '23514' });
    });
  });

  describe('requestAskRegeneration', () => {
    // The suite's own afterEach owns the solicitation tables and agent_runs;
    // `job_outbox` is neither, so this describe cleans up after itself rather
    // than leaving rows in the shared test database for an unrelated outbox
    // suite to count. Keyed on the payload's business id, so it is independent
    // of whether the batch rows have already been deleted.
    afterEach(async () => {
      await writerSql()`
        DELETE FROM job_outbox
        WHERE topic = ${QUEUE_NAMES.GENERATE_SOLICITATION_ASKS}
          AND payload->>'business_id' = ${businessId}
      `;
    }, 30_000);

    /** Postgres.js behind PgBouncer can hand back JSONB as a string — the same
     *  guard `stepDetail` above applies to `agent_run_steps.detail`. */
    function outboxPayload(raw: unknown): Record<string, unknown> {
      const parsed: unknown = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (typeof parsed !== 'object' || parsed === null) {
        throw new Error('job_outbox payload is not an object');
      }
      return parsed as Record<string, unknown>;
    }

    async function readInflightOutbox(batchId: string) {
      return writerSql()<{ id: string; payload: unknown }[]>`
        SELECT id, payload
        FROM job_outbox
        WHERE topic = ${QUEUE_NAMES.GENERATE_SOLICITATION_ASKS}
          AND aggregate_id = ${batchId}
          AND status IN ('pending', 'dispatching', 'dispatched')
      `;
    }

    /**
     * The SQL text of every statement one call issued, in order.
     *
     * The file's two shared handles carry no `debug` hook on purpose — it would
     * record every statement of every case in this suite — so the ordering
     * probe opens its OWN short-lived connection with one attached and closes
     * it again. This is the only place statement text is observable, and the
     * enqueue-first lock order has no other deterministic witness.
     */
    async function captureStatements(
      run: (handle: postgresType.Sql) => Promise<void>,
    ): Promise<string[]> {
      const captured: string[] = [];
      const capture = postgres(assertLocalTestDatabaseUrl(testDatabaseUrl), {
        max: 2,
        prepare: false,
        debug: (_connection, query) => {
          captured.push(query);
        },
      });
      try {
        await run(capture);
      } finally {
        await capture.end();
      }
      return captured;
    }

    it('enqueues one generate_solicitation_asks outbox row carrying the ask id for a built batch', async () => {
      const seeded = await seedRenderedBatch({ renders: 2 });
      const outreachBefore = await snapshotOutreach(seeded.batchId);

      const result = await requestAskRegeneration(sql(), {
        batchId: seeded.batchId,
        askId: seeded.asks[0]!.askId,
        accountId: accountId(),
        businessId,
        requestedByUserId: userId(),
        // Fresh budget. Every call in this suite passes it explicitly — the
        // field is required, and `null` (UNKNOWN) would mask a budget defect.
        budgetRemaining: 3,
      });

      expect(result).toEqual({ status: 'accepted' });
      const rows = await readInflightOutbox(seeded.batchId);
      expect(rows).toHaveLength(1);
      expect(outboxPayload(rows[0]!.payload).ask_id).toBe(seeded.asks[0]!.askId);
      // The request writes NO domain state: the live render is untouched and
      // the worker owns every mutation.
      expect(await snapshotOutreach(seeded.batchId)).toEqual(outreachBefore);
    });

    it('records ask_regeneration_requested on the send parent with the requesting owner', async () => {
      const seeded = await seedRenderedBatch({ renders: 2 });

      await requestAskRegeneration(sql(), {
        batchId: seeded.batchId,
        askId: seeded.asks[0]!.askId,
        accountId: accountId(),
        businessId,
        requestedByUserId: userId(),
        budgetRemaining: 3,
      });

      const steps = await readSteps(seeded.parentRunId, 'ask_regeneration_requested');
      expect(steps).toHaveLength(1);
      expect(stepDetail(steps[0]!)).toMatchObject({
        ask_id: seeded.asks[0]!.askId,
        requested_by_user_id: userId(),
      });
      // The persona comes from STEP_PERSONA, never from the caller — the step
      // key had to be registered there for this to be anything but a tsc error.
      expect(steps[0]!.attributed_agent).toBe('solicitation');
    });

    it('refuses a regenerate for an approved batch without writing an outbox row', async () => {
      const seeded = await seedRenderedBatch({ renders: 2 });
      await approveBatch(sql(), {
        batchId: seeded.batchId,
        accountId: accountId(),
        businessId,
        approvedByUserId: userId(),
        excludedOutreachIds: [],
      });

      const result = await requestAskRegeneration(sql(), {
        batchId: seeded.batchId,
        askId: seeded.asks[0]!.askId,
        accountId: accountId(),
        businessId,
        requestedByUserId: userId(),
        budgetRemaining: 3,
      });

      // ADR 0020, asserted against the DATABASE rather than the return value:
      // the refusal is only worth anything if nothing was enqueued.
      expect(result.status).toBe('not_regenerable');
      expect(await readInflightOutbox(seeded.batchId)).toHaveLength(0);
    });

    it('refuses a regenerate for an ask whose current attempt is withheld', async () => {
      const seeded = await seedRenderedBatch({ renders: 2 });
      await writerSql()`
        UPDATE solicitation_outreach
        SET delivery_status = 'withheld',
            disposition_reason = 'lint_failed',
            rendered_subject = NULL,
            rendered_body = NULL
        WHERE ask_id = ${seeded.asks[0]!.askId}::uuid
      `;

      const result = await requestAskRegeneration(sql(), {
        batchId: seeded.batchId,
        askId: seeded.asks[0]!.askId,
        accountId: accountId(),
        businessId,
        requestedByUserId: userId(),
        budgetRemaining: 3,
      });

      // §8.2 r6: blocked is terminal. Re-rolling it would launder the
      // fail-closed lint.
      expect(result).toEqual({ status: 'ask_not_regenerable', deliveryStatus: 'withheld' });
      expect(await readInflightOutbox(seeded.batchId)).toHaveLength(0);
    });

    it('returns already_in_flight when a generation is already in flight for the batch', async () => {
      const seeded = await seedRenderedBatch({ renders: 2 });
      const first = await requestAskRegeneration(sql(), {
        batchId: seeded.batchId,
        askId: seeded.asks[0]!.askId,
        accountId: accountId(),
        businessId,
        requestedByUserId: userId(),
        budgetRemaining: 3,
      });
      expect(first.status).toBe('accepted');

      // A DIFFERENT ask: the dedup is keyed on the batch, not the ask, which is
      // the fact that makes "regenerate all" impossible as a fan-out.
      const second = await requestAskRegeneration(sql(), {
        batchId: seeded.batchId,
        askId: seeded.asks[1]!.askId,
        accountId: accountId(),
        businessId,
        requestedByUserId: userId(),
        budgetRemaining: 3,
      });

      expect(second).toEqual({ status: 'already_in_flight' });
      expect(await readInflightOutbox(seeded.batchId)).toHaveLength(1);
    });

    it('refuses a regenerate for a batch belonging to another tenant', async () => {
      const seeded = await seedRenderedBatch({ renders: 2 });
      const foreign = foreignTenantSeed();

      const result = await requestAskRegeneration(sql(), {
        batchId: seeded.batchId,
        askId: seeded.asks[0]!.askId,
        // The foreign ACCOUNT with the REAL business id, matching this file's
        // existing `describe('tenant scope', ...)`. Mismatching both keys is
        // the weaker probe: it would still pass if the account predicate were
        // missing entirely, because the business predicate alone would refuse.
        accountId: foreign.accountId,
        businessId,
        requestedByUserId: foreign.userId,
        budgetRemaining: 3,
      });

      // A foreign batch id and an unknown one are indistinguishable.
      expect(result).toEqual({ status: 'not_found' });
      expect(await readInflightOutbox(seeded.batchId)).toHaveLength(0);
    });

    it('answers not_found for a foreign tenant whose batch already has a regeneration in flight', async () => {
      // Round-1 R5. The enqueue's `ON CONFLICT (topic, aggregate_id)` carries
      // NO tenant discriminator, so answering its dedup arm straight off the
      // probe made a FOREIGN batch id that is currently regenerating answer
      // 409 where an unknown one answers 404 — an existence-and-activity
      // oracle across the tenant boundary.
      //
      // The pre-existing foreign-tenant case above covers only the NO-conflict
      // branch, which is why the leak survived it. This one seeds the conflict
      // first and probes the same door.
      const seeded = await seedRenderedBatch({ renders: 2 });
      const inFlight = await requestAskRegeneration(sql(), {
        batchId: seeded.batchId,
        askId: seeded.asks[0]!.askId,
        accountId: accountId(),
        businessId,
        requestedByUserId: userId(),
        budgetRemaining: 3,
      });
      expect(inFlight.status).toBe('accepted');

      const foreign = foreignTenantSeed();
      const result = await requestAskRegeneration(sql(), {
        batchId: seeded.batchId,
        askId: seeded.asks[1]!.askId,
        // Foreign ACCOUNT with the real business id, matching the sibling case
        // above: mismatching both keys would still pass with the account
        // predicate missing entirely.
        accountId: foreign.accountId,
        businessId,
        requestedByUserId: foreign.userId,
        budgetRemaining: 3,
      });

      // Indistinguishable from an unknown id — NOT `already_in_flight`.
      expect(result).toEqual({ status: 'not_found' });
      // And the owner's real in-flight row is untouched: the refused request
      // neither wrote a second row nor consumed the first.
      expect(await readInflightOutbox(seeded.batchId)).toHaveLength(1);
    });

    it('refuses an exhausted per-ask budget and leaves no outbox row behind', async () => {
      // Round-1 R4. `budget_exhausted` ABORTS BY THROWING, because postgres.js
      // commits when the `sql.begin` callback resolves and the enqueue-first
      // lock order has already written the outbox row by the time this gate is
      // reached. A `return` here would refuse the owner AND start the
      // regeneration anyway — money spent on a request the server declined.
      //
      // So the return value alone is not the assertion. The DATABASE is: no
      // `job_outbox` row of ANY status may survive the transaction, and the
      // owner-attribution step must not exist either.
      const seeded = await seedRenderedBatch({ renders: 2 });

      const result = await requestAskRegeneration(sql(), {
        batchId: seeded.batchId,
        askId: seeded.asks[0]!.askId,
        accountId: accountId(),
        businessId,
        requestedByUserId: userId(),
        // The one value every other case in this suite avoids: 0 remaining.
        // `null` is UNKNOWN (the advisory peek could not answer) and proceeds;
        // 0 is a known-spent budget and must refuse.
        budgetRemaining: 0,
      });

      expect(result).toEqual({ status: 'budget_exhausted' });

      // Deliberately UNFILTERED by status, unlike readInflightOutbox: the claim
      // is that the row was rolled back, not merely that it is not in flight.
      const rows = await writerSql()<{ id: string }[]>`
        SELECT id
        FROM job_outbox
        WHERE topic = ${QUEUE_NAMES.GENERATE_SOLICITATION_ASKS}
          AND aggregate_id = ${seeded.batchId}
      `;
      expect(rows).toHaveLength(0);
      expect(await readSteps(seeded.parentRunId, 'ask_regeneration_requested')).toHaveLength(0);
    });

    it('accepts a regenerate when the budget is UNKNOWN, so an Upstash outage cannot close the lane', async () => {
      // Round-2 finding: R4 shipped only its fail-CLOSED half. The case above
      // pins `0` (known-spent → refuse); nothing pinned `null`, and `null` is
      // the load-bearing one.
      //
      // `null` means the advisory peek could not answer — Redis unreachable, so
      // `peekAskRegenBudgetBatch` failed open to an empty map and the route
      // passed `budget?.remaining ?? null`. CLAUDE.md: "API rate limits fail
      // OPEN by design… Never make the limiters strict." The worker's Lua INCR
      // is the authoritative gate and is itself retryable, so proceeding here
      // cannot overspend — it can only make the owner wait for a real refusal.
      //
      // Without this test the guard can be rewritten as
      // `(input.budgetRemaining ?? 0) <= 0`, which type-checks, keeps every
      // other case green, and silently converts an Upstash outage into a dead
      // regenerate lane for every owner at once.
      const seeded = await seedRenderedBatch({ renders: 2 });

      const result = await requestAskRegeneration(sql(), {
        batchId: seeded.batchId,
        askId: seeded.asks[0]!.askId,
        accountId: accountId(),
        businessId,
        requestedByUserId: userId(),
        budgetRemaining: null,
      });

      expect(result).toEqual({ status: 'accepted' });

      // …and it is a REAL acceptance: the work was actually enqueued and the
      // owner actually attributed. A `budget_exhausted` that happened to
      // stringify as accepted would not survive these two.
      const rows = await writerSql()<{ id: string }[]>`
        SELECT id
        FROM job_outbox
        WHERE topic = ${QUEUE_NAMES.GENERATE_SOLICITATION_ASKS}
          AND aggregate_id = ${seeded.batchId}
      `;
      expect(rows).toHaveLength(1);
      expect(await readSteps(seeded.parentRunId, 'ask_regeneration_requested')).toHaveLength(1);
    });

    it('rolls back the regeneration outbox row when recording ask_regeneration_requested fails', async () => {
      const seeded = await seedRenderedBatch({ renders: 2 });

      // The enqueue-first order means the outbox row is written BEFORE the step.
      // If the step could fail without taking the row with it, an owner would
      // get a regeneration nobody asked for and no record of who asked —
      // invariant #2 broken in the one direction the ordering makes possible.
      //
      // Forced with a real fixture mutation rather than a mock: the send parent
      // is re-pointed at another subject, so `lockBatchForAction`'s correlated
      // lookup no longer resolves it and the step CANNOT be recorded. A
      // literally non-existent run id is unrepresentable here — the id is read
      // inside the same transaction that uses it — so this is the deterministic
      // form of "recording the step fails". The run row itself SURVIVES, which
      // is what keeps the step assertion below a real oracle rather than a
      // vacuous read of a cascade-deleted parent.
      await writerSql()`
        UPDATE agent_runs
        SET subject_id = ${randomUUID()}
        WHERE id = ${seeded.parentRunId}::uuid
      `;

      await expect(
        requestAskRegeneration(sql(), {
          batchId: seeded.batchId,
          askId: seeded.asks[0]!.askId,
          accountId: accountId(),
          businessId,
          requestedByUserId: userId(),
          budgetRemaining: 3,
        }),
      ).rejects.toThrow();

      expect(await readInflightOutbox(seeded.batchId)).toHaveLength(0);
      expect(await readSteps(seeded.parentRunId, 'ask_regeneration_requested')).toHaveLength(0);
    });

    it('does not deadlock when a worker completion races a second regeneration request', async () => {
      const seeded = await seedRenderedBatch({ renders: 2 });

      // PART 1 — the ordering assertion. This is the part that actually guards
      // round 1's critical defect, and it is deterministic.
      //
      // A provoked ABBA is NOT used here, and the reason is worth stating so
      // nobody "improves" this test into one: reproducing it needs a third
      // session holding the advisory lock while the worker waits for it, and
      // which side Postgres kills is nondeterministic. A flaky deadlock test is
      // worse than none, because the failure mode people learn to ignore is
      // exactly the failure mode this bug has.
      //
      // So assert the ORDER instead: the outbox INSERT must be the first
      // statement, before any advisory lock. That is the whole invariant.
      let first: RequestAskRegenerationResult | undefined;
      const stmts = await captureStatements(async (handle) => {
        first = await requestAskRegeneration(handle, {
          batchId: seeded.batchId,
          askId: seeded.asks[0]!.askId,
          accountId: accountId(),
          businessId,
          requestedByUserId: userId(),
          budgetRemaining: 3,
        });
      });
      expect(first).toEqual({ status: 'accepted' });

      const outboxAt = stmts.findIndex((s) => s.includes('INSERT INTO job_outbox'));
      const advisoryAt = stmts.findIndex((s) => s.includes('pg_advisory_xact_lock'));
      expect(outboxAt).toBeGreaterThanOrEqual(0);
      expect(advisoryAt).toBeGreaterThanOrEqual(0);
      expect(outboxAt).toBeLessThan(advisoryAt);

      // PART 2 — the serialization, proving the order it settled on does not
      // self-deadlock against a real worker holding that row.
      const [inflight] = await readInflightOutbox(seeded.batchId);
      const worker = writerSql();
      let second!: Promise<RequestAskRegenerationResult>;

      await worker.begin(async (tx) => {
        // The worker's opening move, in the worker's real order: outbox row
        // first, advisory lock second.
        await tx`
          UPDATE job_outbox SET status = 'completed'
          WHERE id = ${inflight!.id}::uuid
        `;
        await acquireSolicitationBatchLock(tx, businessId);

        second = requestAskRegeneration(sql(), {
          batchId: seeded.batchId,
          askId: seeded.asks[1]!.askId,
          accountId: accountId(),
          businessId,
          requestedByUserId: userId(),
          budgetRemaining: 3,
        });

        // Let it reach the outbox row and block there. NOT awaited inside this
        // callback: postgres.js commits when the callback resolves, so awaiting
        // a promise that cannot settle until this transaction commits would
        // hang the test under the CORRECT ordering too.
        await new Promise((resolve) => setTimeout(resolve, 250));
      });

      // Commit released both locks; the blocked request now completes.
      await expect(second).resolves.toEqual({ status: 'accepted' });
    });
  });

  describe('mixed-case batch id', () => {
    it('finds the send parent for an upper-cased batch id, for both verbs', async () => {
      // `agent_runs.subject_id` is TEXT, so matching it is case-SENSITIVE while
      // `b.id = $1::uuid` normalises — and `isValidUuid`, the routes' only
      // validator, accepts upper case. An upper-cased id therefore used to find
      // the batch and MISS its parent: approveBatch threw (a 500 the owner could
      // reach) and haltBatch silently dropped its `batch_halted` audit record.
      const approving = await seedRenderedBatch({ renders: 2 });
      // Only one of the two is ever approved — two approved batches would
      // contend for solicitation_batches_one_active_send_per_business.
      const halting = await seedRenderedBatch({ renders: 1 });

      const approved = await approveBatch(sql(), {
        batchId: approving.batchId.toUpperCase(),
        accountId: approving.accountId,
        businessId: approving.businessId,
        approvedByUserId: approving.userId,
        excludedOutreachIds: [],
      });
      const halted = await haltBatch(sql(), {
        batchId: halting.batchId.toUpperCase(),
        accountId: halting.accountId,
        businessId: halting.businessId,
        haltedByUserId: halting.userId,
      });

      expect(approved).toMatchObject({ status: 'approved', approvedCount: 2 });
      // `closed` rather than `no_send_parent` is the second half of the same
      // regression: closeBatchIfSettled resolves the parent with the identical
      // TEXT compare, so it has to receive the canonical id too.
      expect(halted).toMatchObject({
        status: 'halted',
        reason: 'owner_veto',
        cancelledCount: 1,
        close: { status: 'closed', disposition: 'halted', parentStatus: 'cancelled' },
      });
      // The steps are what the case is really about: both verbs wrote their
      // domain rows either way, and only the audit record went missing.
      expect(await readSteps(approving.parentRunId, 'batch_approved')).toHaveLength(1);
      expect(await readSteps(halting.parentRunId, 'batch_halted')).toHaveLength(1);
    });
  });

  describe('tenant scope', () => {
    it('refuses to approve or halt a batch owned by another account', async () => {
      const { batchId, accountId: account, businessId: business, userId: owner } =
        await seedRenderedBatch({ renders: 2 });
      const foreign = foreignTenantSeed();
      const batchBefore = await snapshotBatch(batchId);
      const outreachBefore = await snapshotOutreach(batchId);

      const results = [
        await approveBatch(sql(), {
          batchId,
          accountId: foreign.accountId,
          businessId: business,
          approvedByUserId: foreign.userId,
          excludedOutreachIds: [],
        }),
        await haltBatch(sql(), {
          batchId,
          accountId: foreign.accountId,
          businessId: business,
          haltedByUserId: foreign.userId,
        }),
        await approveBatch(sql(), {
          batchId,
          accountId: account,
          businessId: siblingBusinessId,
          approvedByUserId: owner,
          excludedOutreachIds: [],
        }),
        await haltBatch(sql(), {
          batchId,
          accountId: account,
          businessId: siblingBusinessId,
          haltedByUserId: owner,
        }),
      ];

      // Two boundaries, both verbs. The foreign account is the obvious one; the
      // SECOND pair is the point — the right owner reaching for their other
      // location is what a single-key `WHERE id = …` would wrongly approve.
      // A uniform `not_found` also keeps a foreign batch id indistinguishable
      // from an unknown one.
      expect(results).toEqual([
        { status: 'not_found' },
        { status: 'not_found' },
        { status: 'not_found' },
        { status: 'not_found' },
      ]);
      expect(await snapshotBatch(batchId)).toBe(batchBefore);
      expect(await snapshotOutreach(batchId)).toEqual(outreachBefore);
    });
  });

  // ── adminHaltBatch — the admin arm of the Halt latch (#865) ───────────────
  describe('adminHaltBatch', () => {
    /** The admin arm's input, with only the fields a case varies spelled out. */
    function adminInput(
      batchId: string,
      overrides: { accountId?: string; businessId?: string; note?: string } = {},
    ): {
      batchId: string;
      accountId: string;
      businessId: string;
      actorUserId: string;
      note: string;
    } {
      return {
        batchId,
        accountId: overrides.accountId ?? accountId(),
        businessId: overrides.businessId ?? businessId,
        actorUserId: adminUserId,
        note: overrides.note ?? ADMIN_NOTE,
      };
    }

    it('adminHaltBatch latches admin_halt and records the acting admin in halted_by', async () => {
      const { batchId } = await seedRenderedBatch({ renders: 2 });

      const result = await approvalModule.adminHaltBatch(sql(), adminInput(batchId));

      expect(result).toMatchObject({ status: 'halted', cancelledCount: 2 });
      // There is deliberately NO `reason` field on this result (plan §3.1): it
      // is always `admin_halt`, and carrying it would invite a caller to
      // believe it varies. That is the shape difference from HaltBatchResult,
      // which must report a DERIVED reason.
      expect(result).not.toHaveProperty('reason');
      expect(await readHalt(batchId)).toMatchObject({
        halt_reason: 'admin_halt',
        halted_by: adminUserId,
      });
      // The operator is not a member of the account they acted on — `halted_by`
      // is a FK to the global users table (D1), not to a tenant membership.
      expect(await readHalt(batchId)).not.toMatchObject({ halted_by: userId() });
    });

    it('adminHaltBatch is monotone — a second halt adds neither a second audit row nor a second batch_halted spine step', async () => {
      const { batchId, parentRunId } = await seedRenderedBatch({ renders: 2 });

      const first = await approvalModule.adminHaltBatch(sql(), adminInput(batchId));
      const latchedAt = (await readHalt(batchId)).halted_at;
      const second = await approvalModule.adminHaltBatch(sql(), adminInput(batchId));

      expect(first).toMatchObject({ status: 'halted', cancelledCount: 2 });
      expect(second).toEqual({ status: 'already_halted' });
      // The CAS on `halted_at IS NULL` is what makes the second call inert.
      // Without it the latch restamps, the audit trail records the wrong
      // instant, and the account collects a second "support stopped this"
      // receipt for one act.
      expect(latchedAt).not.toBeNull();
      expect((await readHalt(batchId)).halted_at).toBe(latchedAt);
      expect(await readSteps(parentRunId, 'batch_halted')).toHaveLength(1);
      expect(await readAuditRows(batchId)).toHaveLength(1);
    });

    it('adminHaltBatch leaves the send parent running while a sending outreach row remains live', async () => {
      const { batchId, uploadId, parentRunId } = await seedRenderedBatch({ renders: 1 });
      const sendingAsk = await seedSendAsk(batchId, uploadId);
      await seedAttempt({ batchId, ask: sendingAsk, deliveryStatus: 'sending' });
      await stampSendingBatch(batchId);

      const result = await approvalModule.adminHaltBatch(sql(), adminInput(batchId));

      // The in-flight row is still live, so the join answers `not_settled` and
      // the batch does NOT close — the row that resolves itself will close it.
      expect(result).toMatchObject({
        status: 'halted',
        cancelledCount: 1,
        close: { status: 'not_settled', liveCount: 1 },
      });
      expect(await readRunStatus(parentRunId)).toBe('running');
      expect((await readBatch(batchId)).send_closed_at).toBeNull();
    });

    it('adminHaltBatch cancels rendered and queued outreach rows with disposition_reason admin_halt', async () => {
      const { batchId, uploadId, outreachIds } = await seedRenderedBatch({ renders: 1 });
      const queuedAsk = await seedSendAsk(batchId, uploadId);
      const queuedId = await seedAttempt({ batchId, ask: queuedAsk, deliveryStatus: 'queued' });
      const sendingAsk = await seedSendAsk(batchId, uploadId);
      const sendingId = await seedAttempt({ batchId, ask: sendingAsk, deliveryStatus: 'sending' });
      await stampSendingBatch(batchId);

      const result = await approvalModule.adminHaltBatch(sql(), adminInput(batchId));

      expect(result).toMatchObject({ status: 'halted', cancelledCount: 2 });
      const rows = await readOutreach(batchId);
      for (const id of [outreachIds[0]!, queuedId]) {
        expect(rows.find((row) => row.id === id)).toMatchObject({
          delivery_status: 'cancelled',
          disposition_reason: 'admin_halt',
        });
      }
      // `sending` is past the point of no return. Halt means "no further
      // sends", not "undo a dispatch the provider may already have accepted" —
      // and 108's status/reason CHECK would take `admin_halt` on this row
      // happily, so only this assertion catches a widened cancel predicate.
      expect(rows.find((row) => row.id === sendingId)).toMatchObject({
        delivery_status: 'sending',
        disposition_reason: null,
      });
    });

    it('adminHaltBatch records solicitation_batch_admin_halted with the note, actor, entity, location, state_at_halt and cancelled_count', async () => {
      const { batchId } = await seedRenderedBatch({ renders: 2 });

      await approvalModule.adminHaltBatch(sql(), adminInput(batchId));

      const rows = await readAuditRows(batchId);
      expect(rows).toHaveLength(1);
      // `<domain>_<verb-past>` (D6), explicitly admin-scoped so a future
      // owner-arm audit row cannot collide with it.
      expect(rows[0]!).toMatchObject({
        event_type: 'solicitation_batch_admin_halted',
        actor_user_id: adminUserId,
        entity_type: 'solicitation_batch',
        entity_id: batchId,
        location_id: businessId,
        account_id: accountId(),
      });
      expect(auditPayload(rows[0]!)).toMatchObject({
        note: ADMIN_NOTE,
        halt_reason: 'admin_halt',
        state_at_halt: 'built',
        cancelled_count: 2,
      });
      // The note lands in the payload and NOWHERE else: `halt_reason` is fixed
      // by the route's identity (ticket constraint 2).
      expect((await readHalt(batchId)).halt_reason).toBe('admin_halt');
    });

    it('adminHaltBatch rolls back the latch, the outreach cancellations and the audit row when writeAccountAuditLog fails', async () => {
      const { batchId, parentRunId } = await seedRenderedBatch({ renders: 2 });
      const before = await snapshotOutreach(batchId);
      // A JS rejection is the right injection HERE, unlike the aborted-
      // transaction cases that need helpers/abort-injection.ts: the claim under
      // test is that postgres.js rolls the transaction back when the `sql.begin`
      // callback rejects, not that the writer survives an already-poisoned one.
      spies.writeAccountAuditLog.mockRejectedValueOnce(new Error('audit sink unavailable'));

      await expect(
        approvalModule.adminHaltBatch(sql(), adminInput(batchId)),
      ).rejects.toThrow('audit sink unavailable');

      // The latch, the cancellations AND the audit row all go together — the
      // audit write is inside the latch transaction (D7), not beside it.
      expect(await readHalt(batchId)).toMatchObject({
        halted_at: null,
        halt_reason: null,
        halted_by: null,
      });
      expect(await snapshotOutreach(batchId)).toEqual(before);
      expect(await readAuditRows(batchId)).toHaveLength(0);
      // And nothing reached the run spine. The audit write sits BEFORE the
      // spine calls precisely so a failing audit cannot leave a `batch_halted`
      // step behind on a batch that was never halted.
      expect(await readSteps(parentRunId, 'batch_halted')).toHaveLength(0);
      expect(spies.recordStep).not.toHaveBeenCalled();
      expect(spies.closeBatchIfSettled).not.toHaveBeenCalled();
      expect(await readRunStatus(parentRunId)).toBe('running');
    });

    it('adminHaltBatch writes its audit row before recordStep and closeBatchIfSettled, on the same transaction', async () => {
      const { batchId } = await seedRenderedBatch({ renders: 2 });
      const { executor, queries, transactions } = instrumentedExecutor(sql());

      await approvalModule.adminHaltBatch(executor, adminInput(batchId));

      // RECEIVER IDENTITY. One transaction was opened, and all three
      // collaborators were handed THAT object — not the pooled client the
      // caller passed in. An audit written on the base client commits
      // independently of the latch and survives its rollback.
      expect(transactions).toHaveLength(1);
      expect(spies.writeAccountAuditLog).toHaveBeenCalledTimes(1);
      const auditReceiver = spies.writeAccountAuditLog.mock.calls[0]![0] as unknown;
      expect(auditReceiver).toBe(transactions[0]);
      expect(auditReceiver).not.toBe(executor);
      expect(spies.recordStep.mock.calls[0]![0]).toBe(auditReceiver);
      expect(spies.closeBatchIfSettled.mock.calls[0]![0]).toBe(auditReceiver);

      // CALL ORDER. Lock order is advisory -> `solicitation_batches` row ->
      // `agent_runs`, so every run-spine call happens LAST; an audit written
      // after recordStep inverts it and is the ABBA deadlock this file's header
      // describes against the offboarding purge.
      const auditAt = spies.writeAccountAuditLog.mock.invocationCallOrder[0]!;
      expect(auditAt).toBeLessThan(spies.recordStep.mock.invocationCallOrder[0]!);
      expect(auditAt).toBeLessThan(spies.closeBatchIfSettled.mock.invocationCallOrder[0]!);

      // And the statement itself: on the transaction, exactly once, before the
      // spine's step INSERT. Asserted on the query log as well as on the spies
      // so a future direct `INSERT INTO account_audit_log` — which CLAUDE.md's
      // "Audit writes" rule forbids — cannot slip past a spy that is no longer
      // on the path.
      const auditQueries = queries.filter((query) =>
        /INSERT INTO account_audit_log/.test(query.text));
      expect(auditQueries).toHaveLength(1);
      expect(auditQueries[0]!.onTransaction).toBe(true);
      const auditIndex = queries.findIndex((query) =>
        /INSERT INTO account_audit_log/.test(query.text));
      const stepIndex = queries.findIndex((query) =>
        /INSERT INTO agent_run_steps/.test(query.text));
      expect(auditIndex).toBeGreaterThanOrEqual(0);
      expect(stepIndex).toBeGreaterThan(auditIndex);
    });

    it('adminHaltBatch delegates parent settlement to closeBatchIfSettled and never updates agent_runs directly', async () => {
      const { batchId, parentRunId } = await seedRenderedBatch({ renders: 2 });
      const { executor, queries } = instrumentedExecutor(sql());
      // The seam is STUBBED for this one call. With the real join in place the
      // parent's terminalizing `UPDATE agent_runs` is issued BY the seam, and
      // "the latch never updates agent_runs itself" would be unprovable from
      // the query log. Asserting the final parent state instead would pass a
      // direct terminalization, which is exactly the regression at issue.
      spies.closeBatchIfSettled.mockResolvedValueOnce({ status: 'not_settled', liveCount: 0 });

      const result = await approvalModule.adminHaltBatch(
        executor,
        // Mixed case on purpose: `agent_runs.subject_id` is TEXT, so every
        // compare against it is case-SENSITIVE. The seam must receive the
        // CANONICAL id or its own parent lookup misses (D3).
        adminInput(batchId.toUpperCase()),
      );

      expect(result).toMatchObject({
        status: 'halted',
        close: { status: 'not_settled', liveCount: 0 },
      });
      expect(spies.closeBatchIfSettled).toHaveBeenCalledTimes(1);
      const [seamTransaction, seamInput] = spies.closeBatchIfSettled.mock.calls[0]! as [
        unknown,
        unknown,
      ];
      expect(seamTransaction).toBe(spies.recordStep.mock.calls[0]![0]);
      expect(seamInput).toEqual({
        batchId,
        accountId: accountId(),
        businessId,
      });
      expect(queries.filter((query) => /UPDATE\s+agent_runs/i.test(query.text))).toHaveLength(0);
      expect(await readRunStatus(parentRunId)).toBe('running');
    });

    it('adminHaltBatch still calls closeBatchIfSettled for a parentless batch', async () => {
      // Every candidate withheld at decision time means the builder skipped the
      // generation enqueue outright, so this batch has no Send batch parent and
      // never will. The spine step is skipped; the JOIN must still run.
      const { batchId, uploadId } = await seedBatch('2 hours');
      const ask = await seedSendAsk(batchId, uploadId);
      await seedAttempt({ batchId, ask, deliveryStatus: 'rendered' });

      const result = await approvalModule.adminHaltBatch(sql(), adminInput(batchId));

      expect(result).toMatchObject({
        status: 'halted',
        cancelledCount: 1,
        close: { status: 'no_send_parent' },
      });
      expect(spies.recordStep).not.toHaveBeenCalled();
      expect(spies.closeBatchIfSettled).toHaveBeenCalledTimes(1);
      // The audit row is NOT conditional on a parent existing: it is the
      // durable "a RepWorth operator did this" record, and a parentless batch
      // is the case where it is the ONLY record.
      expect(await readAuditRows(batchId)).toHaveLength(1);
      expect(await readHalt(batchId)).toMatchObject({
        halt_reason: 'admin_halt',
        halted_by: adminUserId,
      });
    });

    it('adminHaltBatch halts a batch addressed by a mixed-case id and closes its send parent', async () => {
      const { batchId, parentRunId } = await seedRenderedBatch({ renders: 1 });

      const result = await approvalModule.adminHaltBatch(
        sql(),
        adminInput(batchId.toUpperCase()),
      );

      // `closed` rather than `no_send_parent` is the whole regression:
      // closeBatchIfSettled resolves the parent with the same TEXT compare, so
      // it has to receive the canonical id too.
      expect(result).toMatchObject({
        status: 'halted',
        cancelledCount: 1,
        close: { status: 'closed', disposition: 'halted', parentStatus: 'cancelled' },
      });
      expect(await readSteps(parentRunId, 'batch_halted')).toHaveLength(1);
      expect(await readRunStatus(parentRunId)).toBe('cancelled');
      // The receipt names the canonical id, not the request's casing — an
      // entity_id that varies by caller spelling is not a joinable key.
      const rows = await readAuditRows(batchId);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.entity_id).toBe(batchId);
    });

    it('adminHaltBatch returns not_found for a real batch id under the wrong tenant', async () => {
      const { batchId } = await seedRenderedBatch({ renders: 2 });
      const foreign = foreignTenantSeed();
      const batchBefore = await snapshotBatch(batchId);
      const outreachBefore = await snapshotOutreach(batchId);

      const results = [
        await approvalModule.adminHaltBatch(
          sql(),
          adminInput(batchId, { accountId: foreign.accountId }),
        ),
        await approvalModule.adminHaltBatch(
          sql(),
          adminInput(batchId, { businessId: siblingBusinessId }),
        ),
      ];

      // Two boundaries. The foreign account is the obvious one; the SECOND is
      // the point — the right account reaching for its other location is what a
      // single-key `WHERE id = …` would wrongly halt. A uniform not_found also
      // keeps a foreign batch id indistinguishable from an unknown one, which
      // is what the route's 404 depends on.
      expect(results).toEqual([{ status: 'not_found' }, { status: 'not_found' }]);
      expect(await snapshotBatch(batchId)).toBe(batchBefore);
      expect(await snapshotOutreach(batchId)).toEqual(outreachBefore);
      expect(await readAuditRows(batchId)).toHaveLength(0);
    });

    it('adminHaltBatch returns not_haltable for a closed batch', async () => {
      const { batchId, uploadId } = await seedBatch('1 hour');
      await seedSendParent(batchId);
      const ask = await seedSendAsk(batchId, uploadId);
      await seedAttempt({
        batchId,
        ask,
        deliveryStatus: 'withheld',
        dispositionReason: 'lint_failed',
      });
      await stampClosedBatch(batchId);
      const before = await snapshotBatch(batchId);

      const result = await approvalModule.adminHaltBatch(sql(), adminInput(batchId));

      // Closed is terminal — there is nothing left to stop, and latching over
      // it would rewrite the disposition of a batch that already reported.
      expect(result).toEqual({ status: 'not_haltable', state: 'closed' });
      expect(await snapshotBatch(batchId)).toBe(before);
      expect(await readAuditRows(batchId)).toHaveLength(0);
    });

    it('adminHaltBatch returns not_haltable for an unbuilt pending batch and leaves the builder able to stamp built_at', async () => {
      // D11. 091:176 reads `(halted_at IS NULL OR built_at IS NULL OR
      // halted_at >= built_at)`, so halting a pending batch PASSES the CHECK at
      // halt time through the `built_at IS NULL` arm — and then
      // batch-builder.ts:782-786 stamps built_at = NOW() guarded only on
      // `built_at IS NULL`, producing halted_at < built_at and a CHECK
      // violation that throws inside the builder, far from here.
      const batchId = await seedUnbuiltBatch();
      const before = await snapshotBatch(batchId);

      const result = await approvalModule.adminHaltBatch(sql(), adminInput(batchId));

      expect(result).toEqual({ status: 'not_haltable', state: 'pending' });
      expect(await snapshotBatch(batchId)).toBe(before);
      expect(await readAuditRows(batchId)).toHaveLength(0);

      // The consequence, asserted rather than described: the builder's own CAS
      // still succeeds. This is the assertion that would fail if the guard were
      // dropped, and it fails HERE rather than inside batch-builder.
      const stamped = await sql()`
        UPDATE solicitation_batches
        SET built_at = NOW()
        WHERE id = ${batchId}::uuid
          AND account_id = ${accountId()}::uuid
          AND business_id = ${businessId}::uuid
          AND built_at IS NULL
        RETURNING id
      `;
      expect(stamped.count).toBe(1);
    });
  });

  // ── #1010 T5: `batch_halted` ──────────────────────────────────────────────
  //
  // ONE Refusal per batch WE halted, written by the private `latchHalt` that all
  // three arms share — never one per cancelled Outreach row, and never for a
  // batch the owner halted or a deadline closed.
  //
  // POSITION IS THE CONTRACT, not merely "after the CAS" (plan §5, round-1
  // finding R1-6): the ledger write goes after step 3 (the audit row) and before
  // step 4 (the spine step). Placed immediately after the CAS its failure would
  // precede the cancellations and the audit row, and the rollback case below
  // would pass VACUOUSLY — those writes would never have happened.
  //
  // `occurredAt` is the `'transaction_time'` sentinel: the CAS writes
  // `halted_at = NOW()`, `NOW()` is `transaction_timestamp()` and is stable
  // across the transaction, so the two agree to the microsecond. Reading
  // `halted_at` back through a JS `Date` would truncate exactly those digits.
  describe('Refusal ledger', () => {
    /** The admin arm's input — the same shape the `adminHaltBatch` block uses. */
    function adminHaltInput(batchId: string): {
      batchId: string;
      accountId: string;
      businessId: string;
      actorUserId: string;
      note: string;
    } {
      return {
        batchId,
        accountId: accountId(),
        businessId,
        actorUserId: adminUserId,
        note: ADMIN_NOTE,
      };
    }

    it('an admin halt writes exactly one refusal_events row against the batch id, never one per cancelled outreach', async () => {
      // THREE cancellable rows, and that is the whole point of the fixture. The
      // parent effort's defect was a per-row fan-out of one account-level fact;
      // `toBeGreaterThan` passes on it and a single-outreach fixture cannot see
      // it at all, so this asserts EXACTLY one against a batch that cancels
      // three.
      const { batchId } = await seedRenderedBatch({ renders: 3 });

      const result = await approvalModule.adminHaltBatch(sql(), adminHaltInput(batchId));
      expect(result).toMatchObject({ status: 'halted', cancelledCount: 3 });

      const refusals = await readRefusals(batchId);
      expect(refusals).toHaveLength(1);
      expect(refusals[0]).toMatchObject({
        account_id: accountId(),
        business_id: businessId,
        refusal_source: 'batch_halted',
        subject_type: 'solicitation_batch',
        subject_id: batchId,
        // The halt reason VERBATIM, and the category this lane's map assigns it.
        refusal_code: 'admin_halt',
        refusal_category: BATCH_HALTED_REFUSAL_CATEGORIES.admin_halt,
        all_refusal_codes: null,
      });
    });

    it('an owner halt writes no refusal_events row', async () => {
      // RepWorth refused nothing — the owner did. Claiming otherwise on the
      // Restraint tab would credit us with the owner's own decision, which is
      // why `owner_veto` and `owner_halt` are two of this lane's four nulls.
      //
      // BOTH owner reasons, because the arm derives which one it writes from the
      // Batch state and a guard keyed on one of them would let the other
      // through.
      const veto = await seedRenderedBatch({ renders: 2 });
      await stampVetoWindowBatch(veto.batchId);
      await expect(
        haltBatch(sql(), {
          batchId: veto.batchId,
          accountId: accountId(),
          businessId,
          haltedByUserId: userId(),
        }),
      ).resolves.toMatchObject({ status: 'halted', reason: 'owner_veto' });

      const halted = await seedRenderedBatch({ renders: 2 });
      await stampSendingBatch(halted.batchId);
      await expect(
        haltBatch(sql(), {
          batchId: halted.batchId,
          accountId: accountId(),
          businessId,
          haltedByUserId: userId(),
        }),
      ).resolves.toMatchObject({ status: 'halted', reason: 'owner_halt' });

      // Both batches really latched — so the zero below is a decision NOT
      // recorded, never a halt that did not happen.
      expect((await readHalt(veto.batchId)).halt_reason).toBe('owner_veto');
      expect((await readHalt(halted.batchId)).halt_reason).toBe('owner_halt');
      expect(await readAllRefusals()).toEqual([]);
    });

    it('a second halt of an already-halted batch writes no second refusal_events row', async () => {
      const { batchId } = await seedRenderedBatch({ renders: 2 });

      const first = await approvalModule.adminHaltBatch(sql(), adminHaltInput(batchId));
      const firstRefusals = await readRefusals(batchId);
      const second = await approvalModule.adminHaltBatch(sql(), adminHaltInput(batchId));

      expect(first).toMatchObject({ status: 'halted' });
      expect(second).toEqual({ status: 'already_halted' });

      // The second call returns at its caller's guard, above the CAS, so nothing
      // in `latchHalt` runs at all — no audit row, no step and no Refusal. The
      // partial unique index would ALSO collapse a second write, so the count
      // alone cannot tell a guarded call from a deduplicated one: the
      // `occurred_at` equality below is what proves nothing was re-written.
      const afterRefusals = await readRefusals(batchId);
      expect(afterRefusals).toHaveLength(1);
      expect(afterRefusals[0]!.occurred_at).toBe(firstRefusals[0]!.occurred_at);
      expect(await readAuditRows(batchId)).toHaveLength(1);
    });

    it('a halt Refusal carries occurred_at equal to the solicitation_batches halted_at written by the same transaction', async () => {
      const { batchId } = await seedRenderedBatch({ renders: 2 });

      await approvalModule.adminHaltBatch(sql(), adminHaltInput(batchId));

      const [refusal] = await readRefusals(batchId);
      expect(refusal).toBeDefined();
      // Read as ::text on both sides. The CAS wrote `halted_at = NOW()` and the
      // ledger stamped the same `NOW()`, so the two rendered values are
      // identical — a lane that stamped its own clock lands a few microseconds
      // later and this comparison shows it.
      expect(refusal!.occurred_at).toBe(refusal!.halted_at);
      expect((await readHalt(batchId)).halted_at).toBe(refusal!.occurred_at);
    });

    it("a halt Refusal's occurred_at equals solicitation_batches.halted_at inside PostgreSQL at full microsecond precision", async () => {
      // Round-1 plan review R1-5. The equality is computed by POSTGRES, in the
      // `matches_halted_at` column, precisely because a decoded JS `Date` loses
      // the microseconds: a lane that had added `halted_at` to the CAS's
      // RETURNING and passed it back through JS would compare EQUAL after
      // truncation and this claim would be unfalsifiable (#520).
      const { batchId } = await seedRenderedBatch({ renders: 2 });

      await approvalModule.adminHaltBatch(sql(), adminHaltInput(batchId));

      const [refusal] = await readRefusals(batchId);
      expect(refusal).toBeDefined();
      expect(refusal!.matches_halted_at).toBe(true);
      // The fixture is not vacuous: sub-second digits are actually present, so
      // the equality is not two whole seconds agreeing by accident.
      expect(refusal!.occurred_at).toMatch(/\.\d{1,6}/);
    });

    it('a halt writes its Refusal after cancelling outreach and writing any audit row, but before the run-spine step and settlement join', async () => {
      // Round-1 plan review R1-6. "After the CAS" is not a position: placing the
      // write immediately after it puts its FAILURE ahead of the cancellations
      // and the audit row, which makes the rollback case below pass vacuously
      // while breaking `latchHalt`'s documented five-step order and the
      // advisory -> batch row -> `agent_runs` lock order this file's header
      // describes.
      const { batchId } = await seedRenderedBatch({ renders: 2 });
      const { executor, queries, transactions } = instrumentedExecutor(sql());

      await approvalModule.adminHaltBatch(executor, adminHaltInput(batchId));

      // RECEIVER IDENTITY first: one transaction, and the ledger statement rode
      // it rather than the pooled client the caller passed in. A Refusal written
      // on the base client commits independently of the latch and survives its
      // rollback.
      expect(transactions).toHaveLength(1);
      const ledgerQueries = queries.filter((query) =>
        /INSERT INTO refusal_events/.test(query.text));
      expect(ledgerQueries).toHaveLength(1);
      expect(ledgerQueries[0]!.onTransaction).toBe(true);

      const indexOf = (pattern: RegExp): number =>
        queries.findIndex((query) => pattern.test(query.text));
      const cancelIndex = indexOf(/UPDATE solicitation_outreach/);
      const auditIndex = indexOf(/INSERT INTO account_audit_log/);
      const ledgerIndex = indexOf(/INSERT INTO refusal_events/);
      const stepIndex = indexOf(/INSERT INTO agent_run_steps/);

      expect(cancelIndex).toBeGreaterThanOrEqual(0);
      expect(auditIndex).toBeGreaterThan(cancelIndex);
      // The claim: step 3 (audit) then the ledger, then step 4 (the spine step).
      expect(ledgerIndex).toBeGreaterThan(auditIndex);
      expect(stepIndex).toBeGreaterThan(ledgerIndex);
      // …and the settlement join is last, after the ledger too.
      expect(spies.closeBatchIfSettled).toHaveBeenCalledTimes(1);
      expect(spies.recordStep.mock.invocationCallOrder[0]!)
        .toBeLessThan(spies.closeBatchIfSettled.mock.invocationCallOrder[0]!);
    });

    it('a ledger failure in the halt lane rolls back the latch, the cancellations and the audit row together', async () => {
      const { batchId, parentRunId } = await seedRenderedBatch({ renders: 2 });
      const before = await snapshotOutreach(batchId);

      const original = { ...batchHaltedCategories };
      // A writer bug: a category migration 116's CHECK does not admit. The
      // helper does NOT catch it — a CHECK violation must abort the decision,
      // because catching it would hide the bug in the one place the ledger
      // cannot report it.
      batchHaltedCategories.admin_halt = 'a_category_the_ledger_never_named';
      try {
        await expect(
          approvalModule.adminHaltBatch(sql(), adminHaltInput(batchId)),
        ).rejects.toMatchObject({
          code: CHECK_VIOLATION,
          constraint_name: expect.stringContaining('refusal_events'),
        });
      } finally {
        for (const key of Object.keys(batchHaltedCategories)) delete batchHaltedCategories[key];
        Object.assign(batchHaltedCategories, original);
      }

      // The latch, the cancellations and the audit row all go together. Because
      // the ledger write sits AFTER all three, this case is non-vacuous: each of
      // them really happened inside the transaction before the abort.
      expect(await readHalt(batchId)).toMatchObject({
        halted_at: null,
        halt_reason: null,
        halted_by: null,
      });
      expect(await snapshotOutreach(batchId)).toEqual(before);
      expect(await readAuditRows(batchId)).toHaveLength(0);
      expect(await readSteps(parentRunId, 'batch_halted')).toHaveLength(0);
      expect(await readRunStatus(parentRunId)).toBe('running');
      expect(await readAllRefusals()).toEqual([]);
    });

    it('every solicitation refusal reason writes its verbatim code and mapped category, and every null-mapped reason writes nothing', async () => {
      // ONE TITLE, THREE INSTANCES — one per lane, in each lane's own suite
      // (`batch-builder.integration.test.ts`, `dispatch.integration.test.ts`,
      // this one). Plan §1: the title "spans T3, T4 and T5 and closes with
      // them". No single suite can drive all three lanes' fixtures, and a case
      // covering one lane while claiming all three would be the over-claim this
      // title exists to prevent. This instance owns the HALT lane, and it is the
      // only place all SIX halt reasons — two owner, one admin, three system —
      // are reachable at once.
      //
      // Round-1 finding R1-4: the promised titles never required RUNTIME absence
      // for all four null-mapped halt reasons, only for `owner_halt`.
      const written = new Map<string, string>();
      const silent: string[] = [];

      async function haltAndRecord(
        batchId: string,
        expectedReason: string,
        halt: () => Promise<unknown>,
      ): Promise<void> {
        await halt();
        expect((await readHalt(batchId)).halt_reason, `${expectedReason} did not latch`)
          .toBe(expectedReason);
        const refusals = await readRefusals(batchId);
        if (refusals.length === 0) {
          silent.push(expectedReason);
          return;
        }
        expect(refusals, `${expectedReason} wrote more than one Refusal`).toHaveLength(1);
        expect(refusals[0]!.refusal_code).toBe(expectedReason);
        written.set(expectedReason, refusals[0]!.refusal_category);
      }

      const veto = await seedRenderedBatch({ renders: 1 });
      await stampVetoWindowBatch(veto.batchId);
      await haltAndRecord(veto.batchId, 'owner_veto', () =>
        haltBatch(sql(), {
          batchId: veto.batchId,
          accountId: accountId(),
          businessId,
          haltedByUserId: userId(),
        }));

      const ownerHalted = await seedRenderedBatch({ renders: 1 });
      await stampSendingBatch(ownerHalted.batchId);
      await haltAndRecord(ownerHalted.batchId, 'owner_halt', () =>
        haltBatch(sql(), {
          batchId: ownerHalted.batchId,
          accountId: accountId(),
          businessId,
          haltedByUserId: userId(),
        }));

      const admin = await seedRenderedBatch({ renders: 1 });
      await haltAndRecord(admin.batchId, 'admin_halt', () =>
        approvalModule.adminHaltBatch(sql(), adminHaltInput(admin.batchId)));

      const windowElapsed = await seedRenderedBatch({ renders: 1 });
      await stampApprovedBatch(windowElapsed.batchId);
      await haltAndRecord(windowElapsed.batchId, 'send_window_elapsed', () =>
        latchSystemHaltUnderLock(windowElapsed.batchId, 'send_window_elapsed'));

      const expired = await seedRenderedBatch({ renders: 1 });
      await haltAndRecord(expired.batchId, 'batch_expired', () =>
        latchSystemHaltUnderLock(expired.batchId, 'batch_expired'));

      const platform = await seedRenderedBatch({ renders: 1 });
      await stampApprovedBatch(platform.batchId);
      await haltAndRecord(platform.batchId, 'platform_halt', () =>
        latchSystemHaltUnderLock(platform.batchId, 'platform_halt'));

      // The two halves of the map, derived from it rather than re-listed — a
      // seventh reason added upstream fails here instead of going unrecorded.
      const mapped = Object.entries(BATCH_HALTED_REFUSAL_CATEGORIES)
        .filter(([, category]) => category !== null);
      const nullMapped = Object.entries(BATCH_HALTED_REFUSAL_CATEGORIES)
        .filter(([, category]) => category === null)
        .map(([reason]) => reason);

      expect(Object.fromEntries(written)).toEqual(Object.fromEntries(mapped));
      expect(silent.sort()).toEqual([...nullMapped].sort());
      // FOUR of the six are null: two owner decisions and two deadlines. That
      // count is what makes this lane's vocabulary comment true.
      expect(nullMapped).toHaveLength(4);
    });

    it("every refusal_events row these three lanes write carries the account and location already in the lane's scope", async () => {
      // ONE TITLE, THREE INSTANCES — see the exhaustive-reason case above. This
      // instance owns the HALT lane.
      //
      // `latchHalt` already holds both keys — its own input carries them, off
      // the locked batch row — so no lane resolves a tenant key it does not
      // hold.
      const { batchId } = await seedRenderedBatch({ renders: 2 });

      await approvalModule.adminHaltBatch(sql(), adminHaltInput(batchId));

      const [refusal] = await readRefusals(batchId);
      expect(refusal).toBeDefined();
      expect(refusal!.account_id).toBe(accountId());
      // NOT NULL: C3 makes a null location mean "account-wide", which this lane
      // is not.
      expect(refusal!.business_id).toBe(businessId);
    });

    it('all three lanes complete their decisions unchanged when REFUSAL_LEDGER_ENABLED is false', async () => {
      // ONE TITLE, THREE INSTANCES — see the exhaustive-reason case above. This
      // instance owns the HALT lane.
      //
      // "Unchanged" is a claim about two runs agreeing, so the comparison is
      // against a REAL ledger-on halt of an identical fixture rather than
      // against a hand-written expectation.
      async function haltAndSnapshot(): Promise<{
        result: unknown;
        halt: { halt_reason: string | null; halted_by: string | null };
        outreach: { delivery_status: string; disposition_reason: string | null }[];
        auditPayloads: Record<string, unknown>[];
        stepDetails: Record<string, unknown>[];
        parentStatus: string;
        refusalCount: number;
      }> {
        const { batchId, parentRunId } = await seedRenderedBatch({ renders: 2 });
        const result = await approvalModule.adminHaltBatch(sql(), adminHaltInput(batchId));
        const halt = await readHalt(batchId);
        return {
          // The settlement join reports the run it terminalized, and that id is
          // freshly minted per fixture — normalised to the fixture's OWN id so
          // the comparison stays a claim about the halt rather than about UUID
          // generation, while still proving the join named the right run.
          result: JSON.parse(
            JSON.stringify(result).replaceAll(parentRunId, '<send-batch-parent>'),
          ) as unknown,
          halt: { halt_reason: halt.halt_reason, halted_by: halt.halted_by },
          outreach: (await readOutreach(batchId)).map((row) => ({
            delivery_status: row.delivery_status,
            disposition_reason: row.disposition_reason,
          })),
          auditPayloads: (await readAuditRows(batchId)).map(auditPayload),
          stepDetails: (await readSteps(parentRunId, 'batch_halted')).map(stepDetail),
          parentStatus: await readRunStatus(parentRunId),
          refusalCount: (await readRefusals(batchId)).length,
        };
      }

      const ledgerOn = await haltAndSnapshot();
      expect(ledgerOn.refusalCount).toBe(1);
      await sql()`DELETE FROM refusal_events WHERE account_id = ${accountId()}::uuid`;

      process.env[REFUSAL_LEDGER_FLAG] = 'false';
      const ledgerOff = await haltAndSnapshot();

      // The latch, the cancellations, the audit receipt, the spine step and the
      // settlement join are all byte-identical…
      expect(ledgerOff.result).toEqual(ledgerOn.result);
      expect(ledgerOff.halt).toEqual(ledgerOn.halt);
      expect(ledgerOff.outreach).toEqual(ledgerOn.outreach);
      expect(ledgerOff.auditPayloads).toEqual(ledgerOn.auditPayloads);
      expect(ledgerOff.stepDetails).toEqual(ledgerOn.stepDetails);
      expect(ledgerOff.parentStatus).toBe(ledgerOn.parentStatus);
      // …and the ONLY difference is the Refusal that was not recorded.
      expect(ledgerOff.refusalCount).toBe(0);
      expect(await readAllRefusals()).toEqual([]);
    });
  });
});
