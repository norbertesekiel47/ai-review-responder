import { randomUUID } from 'node:crypto';
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
  MIGRATION_110_SEND_GOVERNORS,
} from '@/lib/shared/__tests__/helpers/schema-ready';
import {
  cleanupTenantAccount,
  seedLocation,
  seedTenantAccount,
  type TenantSeed,
} from '@/lib/shared/__tests__/live-db-tenant';
import { insertOutreach, seedContactCsvUpload } from '@/lib/shared/__tests__/helpers/outreach-fixture';

// ─────────────────────────────────────────────────────────────────────────────
// Live-DB conventions this file obeys (`ci:live-db-suites`):
//   - named `*.integration.test.ts`, so vitest runs it in the serialized
//     `integration` project;
//   - NO run-time DDL. `pnpm test:db:setup` provisions the schema and
//     `assertSchemaReady` asserts it (#573);
//   - forced failures come from delegating spies and a transaction-preceding
//     proxy, never from a temporary constraint.
//
// It holds the cross-process live-DB lock: `countPlatformDispatchAttemptsToday`
// is CROSS-ACCOUNT by design (the platform ceiling is a blast-radius bound), so
// an unrelated writer in another vitest process would move the baseline the
// ceiling cases are measured against.
//
// Every lifecycle timestamp is written as a SQL interval off NOW(), never as a
// JS `Date`: postgres.js truncates timestamptz microseconds, so a JS-derived
// stamp can mis-order against a NOW()-defaulted sibling by <1ms and trip a
// constraint no case here is about (#520).
// ─────────────────────────────────────────────────────────────────────────────

// DELEGATING spies over the four collaborators whose FAILURE is the subject of
// a case. Each forwards to the real implementation, so every other case runs
// against real behaviour; a case that needs a failure overrides its own spy in
// its own body.
const spies = vi.hoisted(() => ({
  readSendBreaker: vi.fn(),
  enqueueSolicitationSend: vi.fn(),
  completeRun: vi.fn(),
  isJudgeHealthy: vi.fn(),
}));

vi.mock('../send-breaker', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../send-breaker')>();
  spies.readSendBreaker.mockImplementation(actual.readSendBreaker);
  return { ...actual, readSendBreaker: spies.readSendBreaker };
});

vi.mock('@/lib/shared/job-outbox-helpers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/shared/job-outbox-helpers')>();
  spies.enqueueSolicitationSend.mockImplementation(actual.enqueueSolicitationSend);
  return { ...actual, enqueueSolicitationSend: spies.enqueueSolicitationSend };
});

vi.mock('@/lib/agents/run-spine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/agents/run-spine')>();
  spies.completeRun.mockImplementation(actual.completeRun);
  return { ...actual, completeRun: spies.completeRun };
});

vi.mock('@/lib/responses/judge-health', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/responses/judge-health')>();
  spies.isJudgeHealthy.mockImplementation(actual.isJudgeHealthy);
  return { ...actual, isJudgeHealthy: spies.isJudgeHealthy };
});

// The alerting sinks, spread over the REAL module rather than replacing it:
// several modules in this suite's import graph import `@sentry/node`, and only
// these two calls are ever asserted. Nothing here initialises Sentry, so the
// real functions are no-ops anyway — the spies are about ASSERTING them.
const sentrySpies = vi.hoisted(() => ({
  captureException: vi.fn(),
  captureMessage: vi.fn(),
}));

vi.mock('@sentry/node', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@sentry/node')>();
  return {
    ...actual,
    captureException: sentrySpies.captureException,
    captureMessage: sentrySpies.captureMessage,
  };
});

import { STALLED_THRESHOLD_SEND_BATCH_DAYS } from '@/lib/agents/read';
import { resetServerConfigForTests } from '@/lib/config/server';
import { resetWorkerConfigForTests } from '@/lib/config/worker';
import { QUEUE_NAMES } from '@/lib/shared/queue-names';
import {
  countPlatformDispatchAttemptsToday,
  DEFAULT_DAILY_SEND_CAP_ACCOUNT,
} from '../send-caps';
import {
  RELEASE_PER_TICK_BUDGET,
  runReleaseCycle,
  type ReleaseCycleReport,
} from '../release';

const testDatabaseUrl = resolveTestDatabaseUrl();

// THREE locations under ONE account, and the count is forced by migration 091's
// `solicitation_batches_one_active_send_per_business`: at most ONE approved,
// unhalted, unclosed batch may exist per business at a time. A case that needs
// two live approved batches — the flag-scope case needs three — therefore needs
// two more locations, not two more batches.
const businessId = randomUUID();
const siblingBusinessId = randomUUID();
const thirdBusinessId = randomUUID();

// A SECOND ACCOUNT, and the P4 fairness case is the only thing that needs one:
// the daily send cap is per ACCOUNT, so "a capped account must not starve
// everybody else" is not expressible inside one tenant. Seeded here rather than
// inside the case so its rows are torn down by the shared hooks — a leftover
// release CANDIDATE would join every other case's scan.
const foreignBusinessId = randomUUID();

let db: postgresType.Sql | undefined;
let featureDatabaseLock: LiveDbLock | undefined;
let tenant: TenantSeed | undefined;
let foreignTenant: TenantSeed | undefined;
const envBackup = new Map<string, string | undefined>();

function sql(): postgresType.Sql {
  if (!db) throw new Error('release integration database was not initialized');
  return db;
}

function accountId(): string {
  if (!tenant) throw new Error('release integration tenant was not seeded');
  return tenant.accountId;
}

function foreignAccountId(): string {
  if (!foreignTenant) throw new Error('release integration foreign tenant was not seeded');
  return foreignTenant.accountId;
}

function foreignUserId(): string {
  if (!foreignTenant) throw new Error('release integration foreign tenant was not seeded');
  return foreignTenant.userId;
}

function userId(): string {
  if (!tenant) throw new Error('release integration tenant was not seeded');
  return tenant.userId;
}

// ── env ─────────────────────────────────────────────────────────────────────

/**
 * Set a flag/tuning var for one case and clear BOTH config memos so the next
 * `getServerConfig()` / `getWorkerConfig()` re-parses. Production env is
 * immutable, so neither seam ever runs there.
 */
function setEnv(name: string, value: string | undefined): void {
  if (!envBackup.has(name)) envBackup.set(name, process.env[name]);
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  resetServerConfigForTests();
  resetWorkerConfigForTests();
}

/**
 * The platform ceiling is CROSS-ACCOUNT, so a literal cap would be measured
 * against every committed dispatch attempt in the shared database. Every
 * ceiling case therefore expresses its cap as `baseline + headroom`, where the
 * baseline is read at the moment the case runs.
 */
async function setPlatformHeadroom(headroom: number): Promise<number> {
  const baseline = await countPlatformDispatchAttemptsToday(sql());
  setEnv('SOLICITATION_PLATFORM_DAILY_CAP', String(baseline + headroom));
  return baseline;
}

// ── fixtures ────────────────────────────────────────────────────────────────

/**
 * The tenant a fixture writes for. Every helper below TAKES it rather than
 * closing over `accountId()`/`userId()`, because the P4 fairness case needs a
 * SECOND account and a helper bound to the primary tenant cannot be called for
 * it — which is how this file briefly grew a hand-inlined second copy of five of
 * its own helpers. One defaulted parameter removes that whole class.
 */
interface SeedIds {
  accountId: string;
  userId: string;
}

function primaryIds(): SeedIds {
  return { accountId: accountId(), userId: userId() };
}

function foreignIds(): SeedIds {
  return { accountId: foreignAccountId(), userId: foreignUserId() };
}

async function seedUpload(onBusinessId: string, ids: SeedIds = primaryIds()): Promise<string> {
  return seedContactCsvUpload(sql(), {
    accountId: ids.accountId,
    businessId: onBusinessId,
    attestedByUserId: ids.userId,
    filenamePrefix: 'release',
    attestationVersion: 'release-test',
  });
}

async function seedContact(uploadId: string, onBusinessId: string): Promise<string> {
  const contactId = randomUUID();
  await sql()`
    INSERT INTO solicitation_contacts (
      id, business_id, name, email, created_by_upload_id
    ) VALUES (
      ${contactId}::uuid, ${onBusinessId}::uuid, 'Release Candidate',
      ${`${contactId}@example.test`}, ${uploadId}::uuid
    )
  `;
  return contactId;
}

interface BatchInput {
  onBusinessId?: string;
  /** Defaults to the primary tenant; the fairness case passes the foreign one. */
  ids?: SeedIds;
  /**
   * Interval strings off NOW(), e.g. `'1 hour'`. NULL when omitted. A NEGATIVE
   * interval puts the stamp in the FUTURE — `NOW() - INTERVAL '-14 minutes'` is
   * fourteen minutes from now, which is how an unelapsed veto deadline is
   * spelled without ever leaving the database.
   */
  builtAgo?: string;
  approvedAgo?: string;
  approvalMethod?: 'owner' | 'auto_policy';
  vetoDeadlineAgo?: string;
  sendingStartedAgo?: string;
  sendClosedAgo?: string;
  haltedAgo?: string;
  haltReason?:
    | 'owner_veto'
    | 'owner_halt'
    | 'admin_halt'
    | 'send_window_elapsed'
    | 'batch_expired'
    | 'platform_halt';
}

/** Carries its tenant, so every downstream helper reads the ids off the batch
 *  instead of being handed them a second time (or closing over one tenant). */
interface SeededBatch {
  batchId: string;
  uploadId: string;
  businessId: string;
  accountId: string;
  userId: string;
}

/**
 * One batch, carrying only the lifecycle columns the case is about.
 * `created_at` is anchored 40 days back so any `built_at` a case needs still
 * satisfies `solicitation_batches_built_after_created`.
 */
async function seedBatch(input: BatchInput = {}): Promise<SeededBatch> {
  const onBusinessId = input.onBusinessId ?? businessId;
  const ids = input.ids ?? primaryIds();
  const uploadId = await seedUpload(onBusinessId, ids);
  const batchId = randomUUID();
  const ownerHalt =
    input.haltReason === 'owner_veto'
    || input.haltReason === 'owner_halt'
    || input.haltReason === 'admin_halt';
  await sql()`
    INSERT INTO solicitation_batches (
      id, account_id, business_id, source_upload_id, created_at,
      built_at, approved_at, approval_method, approved_by_user_id,
      veto_deadline_at, sending_started_at, send_closed_at,
      halted_at, halt_reason, halted_by
    ) VALUES (
      ${batchId}::uuid, ${ids.accountId}::uuid, ${onBusinessId}::uuid,
      ${uploadId}::uuid, NOW() - INTERVAL '40 days',
      NOW() - ${input.builtAgo ?? null}::interval,
      NOW() - ${input.approvedAgo ?? null}::interval,
      ${input.approvalMethod ?? null},
      ${input.approvalMethod === 'owner' ? ids.userId : null}::uuid,
      NOW() - ${input.vetoDeadlineAgo ?? null}::interval,
      NOW() - ${input.sendingStartedAgo ?? null}::interval,
      NOW() - ${input.sendClosedAgo ?? null}::interval,
      NOW() - ${input.haltedAgo ?? null}::interval,
      ${input.haltReason ?? null}, ${ownerHalt ? ids.userId : null}::uuid
    )
  `;
  return { batchId, uploadId, businessId: onBusinessId, ...ids };
}

/** The shape every releasable case starts from: approved, veto deadline past. */
function approvedBatchInput(overrides: BatchInput = {}): BatchInput {
  return {
    builtAgo: '2 hours',
    approvedAgo: '1 hour',
    approvalMethod: 'owner',
    vetoDeadlineAgo: '45 minutes',
    ...overrides,
  };
}

/**
 * A MID-DRIP batch whose first dispatch attempt has wedged in `sending` past
 * the grace period — the `unknown` sweep's subject.
 *
 * Approved THREE hours back rather than one, and that is 091's
 * `solicitation_batches_send_ordering` talking, not a preference: it requires
 * `sending_started_at >= approved_at`, so a 90-minute-old drip start cannot sit
 * under a one-hour-old approval. Spelling it as its own fixture keeps every
 * `unknown` case from rediscovering that CHECK one at a time.
 */
function wedgedBatchInput(overrides: BatchInput = {}): BatchInput {
  return {
    builtAgo: '4 hours',
    approvedAgo: '3 hours',
    approvalMethod: 'owner',
    vetoDeadlineAgo: '165 minutes',
    sendingStartedAgo: '90 minutes',
    ...overrides,
  };
}

interface SendParentInput {
  batch: SeededBatch;
  status?: 'running' | 'completed' | 'cancelled' | 'failed';
  startedAgo?: string;
}

/** The **Send batch parent** — `agent_runs.kind = 'solicitation_send_batch'`. */
async function seedSendParent(input: SendParentInput): Promise<string> {
  const runId = randomUUID();
  const status = input.status ?? 'running';
  await sql()`
    INSERT INTO agent_runs (
      id, account_id, business_id, kind, subject_type, subject_id,
      status, started_at, ended_at, correlation_id
    ) VALUES (
      ${runId}::uuid, ${input.batch.accountId}::uuid, ${input.batch.businessId}::uuid,
      'solicitation_send_batch', 'solicitation_batch', ${input.batch.batchId},
      ${status}, NOW() - ${input.startedAgo ?? '1 minute'}::interval,
      ${status === 'running' ? null : sql()`NOW()`},
      'release-integration'
    )
  `;
  return runId;
}

/**
 * The **Lazy child** — the per-dispatch-attempt `solicitation_ask` run.
 * `dispatch.ts` mints it inside tx1, BEFORE the `sending` CAS, so a process
 * that died between tx1 and tx2 left BOTH a `sending` Outreach row and a
 * `running` child. That pairing is what the `unknown` sweep must terminalize
 * together.
 */
async function seedLazyChild(
  askId: string,
  onBusinessId: string,
  status: 'running' | 'completed' | 'failed' = 'running',
): Promise<string> {
  const runId = randomUUID();
  await sql()`
    INSERT INTO agent_runs (
      id, account_id, business_id, kind, subject_type, subject_id,
      status, started_at, ended_at, correlation_id
    ) VALUES (
      ${runId}::uuid, ${accountId()}::uuid, ${onBusinessId}::uuid,
      'solicitation_ask', 'solicitation_ask', ${askId},
      ${status}, NOW() - INTERVAL '70 minutes',
      ${status === 'running' ? null : sql()`NOW()`},
      'release-integration'
    )
  `;
  return runId;
}

async function seedAsk(batch: SeededBatch): Promise<{ askId: string; contactId: string }> {
  const contactId = await seedContact(batch.uploadId, batch.businessId);
  const askId = randomUUID();
  await sql()`
    INSERT INTO solicitation_asks (
      id, account_id, business_id, batch_id, contact_id, status,
      withheld_reason, evidence, decided_at
    ) VALUES (
      ${askId}::uuid, ${batch.accountId}::uuid, ${batch.businessId}::uuid,
      ${batch.batchId}::uuid, ${contactId}::uuid, 'send', NULL,
      ${sql().json({ contact_id: contactId, policy_version: 'release-fixture', decision: 'send' })},
      NOW()
    )
  `;
  return { askId, contactId };
}

type OutreachStatus =
  | 'rendered'
  | 'queued'
  | 'sending'
  | 'sent'
  | 'withheld'
  | 'cancelled'
  | 'failed'
  | 'unknown';

interface OutreachInput {
  batch: SeededBatch;
  deliveryStatus?: OutreachStatus;
  dispositionReason?: string | null;
  /** Interval off NOW() for `sending_at` — the `unknown` sweep's grace anchor. */
  sendingAgo?: string;
  /** Interval off NOW() for `queued_at` — the daily-cap counting basis. */
  queuedAgo?: string;
  /**
   * Clamp `queued_at` to the START of the current UTC day instead of letting
   * `queuedAgo` backdate it out of that day.
   *
   * Set it on any fixture whose MEANING is "a dispatch attempt already made
   * TODAY", because the cap counts on a UTC-day predicate — `queued_at >=
   * date_trunc('day', NOW() AT TIME ZONE 'UTC')` in `send-caps.ts`. Without the
   * clamp a fixture backdated five minutes lands in YESTERDAY for the five
   * minutes after 00:00 UTC, the cap silently stops binding, and the test fails
   * for a reason unrelated to the code under test. That is not hypothetical: it
   * is what reddened PR #920's second CI run, which ran 23:59:14 → 00:01:34 UTC.
   *
   * Leave it OFF for wedge and send-window fixtures (`65 minutes`, `69 hours`):
   * those need a genuinely OLD row, and clamping would make them young.
   */
  queuedWithinUtcDay?: boolean;
}

interface SeededOutreach {
  outreachId: string;
  askId: string;
  contactId: string;
}

/** One Outreach row on its OWN ask — 091's live-attempt index is per-ask. */
async function seedOutreach(input: OutreachInput): Promise<SeededOutreach> {
  const { askId, contactId } = await seedAsk(input.batch);
  const status = input.deliveryStatus ?? 'rendered';
  const dispatched = status === 'queued' || status === 'sending' || status === 'sent';
  const outreachId = await insertOutreach(sql(), {
    accountId: input.batch.accountId,
    businessId: input.batch.businessId,
    batchId: input.batch.batchId,
    askId,
    contactId,
    ...(status === 'withheld' ? { renderedSubject: null, renderedBody: null } : {}),
    deliveryStatus: status,
    dispositionReason: input.dispositionReason ?? null,
    // Resolved in SQL, never as a JS `Date`: 091 requires `queued_at` of every
    // dispatched status and `sending_at` of `sending`, and a JS-derived stamp
    // loses its microseconds against the NOW()-defaulted siblings it is
    // ordered against.
    queuedAt: dispatched
      ? input.queuedWithinUtcDay === true
        ? sql()`GREATEST(
            NOW() - ${input.queuedAgo ?? '2 seconds'}::interval,
            date_trunc('day', NOW() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
          )`
        : sql()`NOW() - ${input.queuedAgo ?? '2 seconds'}::interval`
      : null,
    sendingAt: status === 'sending'
      ? sql()`NOW() - ${input.sendingAgo ?? '1 second'}::interval`
      : null,
    sentAt: status === 'sent' ? sql()`NOW()` : null,
  });
  return { outreachId, askId, contactId };
}

/** Link an Outreach row to its Lazy child, as `dispatch.ts` tx1 does. */
async function attachLazyChild(outreachId: string, runId: string): Promise<void> {
  await sql()`
    UPDATE solicitation_outreach
    SET agent_run_id = ${runId}::uuid
    WHERE id = ${outreachId}::uuid
      AND account_id = ${accountId()}::uuid
  `;
}

/**
 * The account's solicitation auto-approval policy row. 091's
 * `auto_approval_policies_persona_consistency` pins the whole row to the
 * sending lane, so persona/action_class/veto window are not knobs here.
 */
async function seedSolicitationPolicy(dailySendCap: number | null): Promise<void> {
  await sql()`
    INSERT INTO auto_approval_policies (
      id, account_id, location_id, persona, action_class,
      veto_window_minutes, daily_send_cap
    ) VALUES (
      ${randomUUID()}::uuid, ${accountId()}::uuid, NULL,
      'solicitation', 'sending', 30, ${dailySendCap}
    )
  `;
}

/** One in-flight `solicitation_send` outbox row for an Outreach id. */
async function seedInFlightSendJob(
  outreachId: string,
  batch: SeededBatch,
  status: 'pending' | 'dispatching' | 'dispatched' = 'pending',
): Promise<string> {
  const outboxId = randomUUID();
  await sql()`
    INSERT INTO job_outbox (id, topic, aggregate_type, aggregate_id, payload, status)
    VALUES (
      ${outboxId}::uuid, ${QUEUE_NAMES.SOLICITATION_SEND}, 'solicitation_outreach',
      ${outreachId}::uuid,
      ${sql().json({
        outreach_id: outreachId,
        batch_id: batch.batchId,
        business_id: batch.businessId,
      })},
      ${status}
    )
  `;
  return outboxId;
}

/**
 * The OTHER account's release candidate, seeded AT its daily send cap.
 *
 * `DEFAULT_DAILY_SEND_CAP_ACCOUNT` dispatch attempts already made today (the
 * cap counts `queued_at` in the UTC day), plus one `rendered` row so the batch
 * is a P4 candidate, plus a **Send batch parent** so nothing else in the tick
 * refuses it for an unrelated reason.
 *
 * Its `approved_at` is deliberately OLDER than `approvedBatchInput`'s, because
 * P4 orders `approved_at ASC`: this is the batch that takes the scan slot.
 */
async function seedCappedForeignCandidate(): Promise<SeededBatch> {
  const batch = await seedBatch({
    ids: foreignIds(),
    onBusinessId: foreignBusinessId,
    builtAgo: '5 hours',
    approvedAgo: '4 hours',
    approvalMethod: 'owner',
    vetoDeadlineAgo: '3 hours',
    sendingStartedAgo: '3 hours',
  });
  await seedSendParent({ batch, startedAgo: '4 hours' });

  // The cap's own number, so the account is at it exactly — one attempt fewer
  // and the arm under test would not fire. The trailing `rendered` row is what
  // makes the batch a P4 candidate at all.
  const statuses = [
    ...Array.from({ length: DEFAULT_DAILY_SEND_CAP_ACCOUNT }, () => 'queued' as const),
    'rendered' as const,
  ];
  for (const status of statuses) {
    // `'0 seconds'` is NOW() exactly, and it is deliberate: the cap's basis is
    // the UTC DAY, so a stamp minutes before midnight would land on yesterday
    // and make this fixture time-of-day dependent.
    await seedOutreach({ batch, deliveryStatus: status, queuedAgo: '0 seconds' });
  }
  return batch;
}

/** Open the **Send breaker**. 110 admits at most one open trip. */
async function tripSendBreaker(): Promise<string> {
  const tripId = randomUUID();
  await sql()`
    INSERT INTO solicitation_send_breaker (id, tripped_at, trip_reason, metrics)
    VALUES (
      ${tripId}::uuid, NOW(), 'hard_bounce_rate',
      ${sql().json({ sends: 1000, hardBounces: 30, complaints: 0 })}
    )
  `;
  return tripId;
}

async function setSubscriptionStatus(status: string): Promise<void> {
  await sql()`
    UPDATE accounts SET subscription_status = ${status} WHERE id = ${accountId()}::uuid
  `;
}

/** The tier is the Auto-approval lane's entitlement dial (`tierGrantsAutopilot`);
 *  the seeded default is `copilot` and the shared afterEach restores it. */
async function setSubscriptionTier(tier: string): Promise<void> {
  await sql()`
    UPDATE accounts SET subscription_tier = ${tier} WHERE id = ${accountId()}::uuid
  `;
}

// ── readers ─────────────────────────────────────────────────────────────────

interface OutreachRow {
  delivery_status: string;
  disposition_reason: string | null;
  queued_at: Date | null;
  sending_at: Date | null;
}

async function readOutreach(outreachId: string): Promise<OutreachRow> {
  const [row] = await sql()<OutreachRow[]>`
    SELECT delivery_status, disposition_reason, queued_at, sending_at
    FROM solicitation_outreach
    WHERE id = ${outreachId}::uuid AND account_id = ${accountId()}::uuid
  `;
  if (!row) throw new Error(`outreach row ${outreachId} vanished`);
  return row;
}

interface BatchRow {
  approved_at: Date | null;
  approval_method: string | null;
  approved_by_user_id: string | null;
  veto_deadline_at: Date | null;
  sending_started_at: Date | null;
  send_closed_at: Date | null;
  halted_at: Date | null;
  halt_reason: string | null;
  halted_by: string | null;
}

async function readBatch(batchId: string): Promise<BatchRow> {
  const [row] = await sql()<BatchRow[]>`
    SELECT approved_at, approval_method, approved_by_user_id::text AS approved_by_user_id,
           veto_deadline_at, sending_started_at, send_closed_at,
           halted_at, halt_reason, halted_by::text AS halted_by
    FROM solicitation_batches
    WHERE id = ${batchId}::uuid AND account_id = ${accountId()}::uuid
  `;
  if (!row) throw new Error(`batch ${batchId} vanished`);
  return row;
}

interface OutboxRow {
  id: string;
  topic: string;
  aggregate_type: string;
  aggregate_id: string;
  status: string;
  payload: unknown;
}

async function readSendJobs(outreachId?: string): Promise<OutboxRow[]> {
  if (outreachId === undefined) {
    return sql()<OutboxRow[]>`
      SELECT id::text AS id, topic, aggregate_type, aggregate_id::text AS aggregate_id,
             status, payload
      FROM job_outbox
      WHERE topic = ${QUEUE_NAMES.SOLICITATION_SEND}
      ORDER BY created_at
    `;
  }
  return sql()<OutboxRow[]>`
    SELECT id::text AS id, topic, aggregate_type, aggregate_id::text AS aggregate_id,
           status, payload
    FROM job_outbox
    WHERE topic = ${QUEUE_NAMES.SOLICITATION_SEND}
      AND aggregate_id = ${outreachId}::uuid
    ORDER BY created_at
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

interface StepRow {
  step_key: string;
  attributed_agent: string;
  detail: unknown;
}

async function readSteps(runId: string, stepKey?: string): Promise<StepRow[]> {
  if (stepKey === undefined) {
    return sql()<StepRow[]>`
      SELECT step_key, attributed_agent, detail FROM agent_run_steps
      WHERE agent_run_id = ${runId}::uuid ORDER BY step_index
    `;
  }
  return sql()<StepRow[]>`
    SELECT step_key, attributed_agent, detail FROM agent_run_steps
    WHERE agent_run_id = ${runId}::uuid AND step_key = ${stepKey}
    ORDER BY step_index
  `;
}

interface RunRow {
  status: string;
  started_at: Date;
  ended_at: Date | null;
  error: unknown;
}

async function readRun(runId: string): Promise<RunRow> {
  const [row] = await sql()<RunRow[]>`
    SELECT status, started_at, ended_at, error FROM agent_runs
    WHERE id = ${runId}::uuid AND account_id = ${accountId()}::uuid
  `;
  if (!row) throw new Error(`run ${runId} vanished`);
  return row;
}

/** The column is `outcome_kind`, not `kind` — migration 071's spelling. */
async function countOutcomes(runId: string, outcomeKind: string): Promise<number> {
  const [row] = await sql()<{ count: number }[]>`
    SELECT COUNT(*)::int AS count FROM agent_outcomes
    WHERE agent_run_id = ${runId}::uuid AND outcome_kind = ${outcomeKind}
  `;
  return row?.count ?? 0;
}

// ── injection ───────────────────────────────────────────────────────────────

/**
 * Wraps `base` so a statement runs on every transaction BEFORE the writer's own
 * callback body.
 *
 * The mirror image of `helpers/abort-injection.ts`, and it exists for the
 * interleavings that injection cannot express: three cases need state to change
 * between a phase's UNLOCKED candidate selection and the transaction that later
 * takes the batch lock. Selection happens outside `sql.begin`, so writing at
 * the top of the transaction reproduces exactly the state the re-read under the
 * lock must catch — a watchdog re-pending an outbox row, an owner halting the
 * batch, the send window elapsing.
 *
 * A `Proxy` over a REAL `Sql`, never an object cast, so the caller typechecks
 * against the shipped interface. `get`-only, so the tagged-template call form
 * forwards untouched; every leading `begin(options, cb)` argument is forwarded,
 * so a writer's isolation level can never be silently dropped.
 */
function precedingExecutor(
  base: postgresType.Sql,
  before: (tx: postgresType.TransactionSql) => Promise<unknown>,
): postgresType.Sql {
  return new Proxy(base, {
    get(target, prop) {
      if (prop !== 'begin') {
        const value: unknown = Reflect.get(target, prop);
        return typeof value === 'function' ? value.bind(target) : value;
      }
      return (...args: unknown[]) => {
        const callback = args[args.length - 1] as (
          tx: postgresType.TransactionSql,
        ) => Promise<unknown>;
        const leading = args.slice(0, -1);
        const wrapped = async (tx: postgresType.TransactionSql): Promise<unknown> => {
          await before(tx);
          return callback(tx);
        };
        return (target.begin as (...forwarded: unknown[]) => Promise<unknown>)(
          ...leading,
          wrapped,
        );
      };
    },
  });
}

function cycle(
  exec: postgresType.Sql = sql(),
  options?: { perTickBudget?: number; scanLimit?: number },
): Promise<ReleaseCycleReport> {
  return runReleaseCycle(exec, options);
}

describeWithDb(
  'runReleaseCycle against live local Postgres',
  { enabled: Boolean(testDatabaseUrl), timeout: 120_000 },
  () => {
    beforeAll(async () => {
      const databaseUrl = assertLocalTestDatabaseUrl(testDatabaseUrl);
      featureDatabaseLock = await acquireLiveDbLock(databaseUrl);
      db = postgres(databaseUrl, {
        max: 4,
        prepare: false,
        // PgBouncer's ~8s default is below what a multi-batch cycle needs.
        connection: { statement_timeout: 30_000 },
      });
      await assertSchemaReady(db, [
        MIGRATION_091_SEND_MODE_SPINE_LIFECYCLE,
        MIGRATION_110_SEND_GOVERNORS,
      ]);
      tenant = await seedTenantAccount(db, {
        userName: 'Release Owner',
        accountDisplayName: 'Release Account',
      });
      for (const [id, name] of [
        [businessId, 'Release Location'],
        [siblingBusinessId, 'Release Sibling Location'],
        [thirdBusinessId, 'Release Third Location'],
      ] as const) {
        await seedLocation(db, tenant.accountId, { businessId: id, name, isPrimary: id === businessId });
      }
      foreignTenant = await seedTenantAccount(db, {
        userName: 'Release Foreign Owner',
        accountDisplayName: 'Release Foreign Account',
      });
      await seedLocation(db, foreignTenant.accountId, {
        businessId: foreignBusinessId,
        name: 'Release Foreign Location',
        isPrimary: true,
      });
    }, LIVE_DB_LOCK_HOOK_TIMEOUT_MS);

    beforeEach(async () => {
      vi.clearAllMocks();
      // Re-arm the delegates, so the PREVIOUS case's `mockRejectedValue` /
      // `mockResolvedValue` cannot leak into this one (`vi.clearAllMocks()`
      // clears calls, not implementations). A case that wants a failure
      // overrides its own spy after this hook.
      //
      // `vi.importActual`, NOT a plain `import`: this file `vi.mock`s all four
      // modules, so a plain dynamic import returns the MOCK, and re-arming a
      // spy with itself is an infinitely recursive implementation — every case
      // that reaches one dies with `Maximum call stack size exceeded` long
      // before its own assertions run.
      const breaker = await vi.importActual<typeof import('../send-breaker')>('../send-breaker');
      spies.readSendBreaker.mockImplementation(breaker.readSendBreaker);
      const spine = await vi.importActual<typeof import('@/lib/agents/run-spine')>(
        '@/lib/agents/run-spine',
      );
      spies.completeRun.mockImplementation(spine.completeRun);
      const judge = await vi.importActual<typeof import('@/lib/responses/judge-health')>(
        '@/lib/responses/judge-health',
      );
      spies.isJudgeHealthy.mockImplementation(judge.isJudgeHealthy);
      const helpers = await vi.importActual<typeof import('@/lib/shared/job-outbox-helpers')>(
        '@/lib/shared/job-outbox-helpers',
      );
      spies.enqueueSolicitationSend.mockImplementation(helpers.enqueueSolicitationSend);

      // The releasable default: lane on, Judge available, ceiling out of the
      // way. Every case that is ABOUT a governor narrows exactly one of these.
      setEnv('SOLICITATION_SEND_ENABLED', 'true');
      setEnv('JUDGE_ENABLED', 'true');
      await setPlatformHeadroom(1_000);
      await setSubscriptionStatus('active');
    });

    afterEach(async () => {
      for (const [name, value] of envBackup) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      envBackup.clear();
      resetServerConfigForTests();
      resetWorkerConfigForTests();

      // The foreign location and account are in every list: a leftover release
      // CANDIDATE over there would join every later case's scan.
      const ownedBusinesses = [
        businessId,
        siblingBusinessId,
        thirdBusinessId,
        foreignBusinessId,
      ];
      const ownedAccounts = [accountId(), foreignAccountId()];
      await sql()`
        DELETE FROM job_outbox
        WHERE topic = ${QUEUE_NAMES.SOLICITATION_SEND}
      `;
      await sql()`DELETE FROM solicitation_send_breaker`;
      await sql()`DELETE FROM solicitation_outreach WHERE business_id IN ${sql()(ownedBusinesses)}`;
      await sql()`DELETE FROM solicitation_asks WHERE business_id IN ${sql()(ownedBusinesses)}`;
      await sql()`DELETE FROM solicitation_batches WHERE business_id IN ${sql()(ownedBusinesses)}`;
      await sql()`DELETE FROM solicitation_contacts WHERE business_id IN ${sql()(ownedBusinesses)}`;
      await sql()`DELETE FROM contact_csv_uploads WHERE business_id IN ${sql()(ownedBusinesses)}`;
      await sql()`DELETE FROM agent_runs WHERE account_id IN ${sql()(ownedAccounts)}`;
      await sql()`DELETE FROM auto_approval_policies WHERE account_id IN ${sql()(ownedAccounts)}`;
      await sql()`DELETE FROM account_audit_log WHERE account_id IN ${sql()(ownedAccounts)}`;
      // The Auto-approval-lane cases (#631) flip the tier; restore the seeded default.
      await setSubscriptionTier('copilot');
    }, 60_000);

    afterAll(async () => {
      try {
        if (db) {
          for (const id of [businessId, siblingBusinessId, thirdBusinessId, foreignBusinessId]) {
            await db`DELETE FROM businesses WHERE id = ${id}::uuid`;
          }
          if (tenant) await cleanupTenantAccount(db, tenant);
          if (foreignTenant) await cleanupTenantAccount(db, foreignTenant);
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

    // ── the release phase ───────────────────────────────────────────────────

    describe('release phase', () => {
      it(
        'releases a rendered Outreach row past its veto deadline and enqueues exactly one solicitation_send outbox row',
        async () => {
          const batch = await seedBatch(approvedBatchInput());
          await seedSendParent({ batch });
          await seedSolicitationPolicy(10);
          const { outreachId } = await seedOutreach({ batch });

          const report = await cycle();

          expect(report.released).toBe(1);
          expect(report.releasePhaseStoppedBy).toBeNull();

          // Invariant #2: the CAS and the outbox INSERT are ONE transaction, so
          // the two are asserted together — a `queued` row with no job is the
          // exact loss this pairing exists to make impossible.
          const row = await readOutreach(outreachId);
          expect(row.delivery_status).toBe('queued');
          expect(row.queued_at).not.toBeNull();

          const jobs = await readSendJobs(outreachId);
          expect(jobs).toHaveLength(1);
          expect(jobs[0]!.status).toBe('pending');
          // 091's stated contract: aggregate_id is the OUTREACH id, not the batch id.
          expect(jobs[0]!.aggregate_id).toBe(outreachId);
          expect(jsonObject(jobs[0]!.payload)).toMatchObject({
            outreach_id: outreachId,
            batch_id: batch.batchId,
            business_id: batch.businessId,
          });
        },
      );

      it('does not release a row before its veto deadline', async () => {
        // D9's veto window is a PREDICATE, not a timer: the row is due only
        // once NOW() has passed the deadline stamped at approval.
        const batch = await seedBatch(
          approvedBatchInput({ approvedAgo: '1 minute', vetoDeadlineAgo: '-14 minutes' }),
        );
        await seedSendParent({ batch });
        await seedSolicitationPolicy(10);
        const { outreachId } = await seedOutreach({ batch });

        const report = await cycle();

        expect(report.released).toBe(0);
        expect((await readOutreach(outreachId)).delivery_status).toBe('rendered');
        expect(await readSendJobs(outreachId)).toHaveLength(0);
        expect((await readBatch(batch.batchId)).sending_started_at).toBeNull();
      });

      it('does not release a halted batch', async () => {
        // The **Halt latch** is monotone and there is no resume, so the release
        // predicate's `halted_at IS NULL` arm is the whole answer.
        const batch = await seedBatch(
          approvedBatchInput({ haltedAgo: '10 minutes', haltReason: 'owner_halt' }),
        );
        await seedSendParent({ batch });
        await seedSolicitationPolicy(10);
        const { outreachId } = await seedOutreach({ batch });

        const report = await cycle();

        expect(report.released).toBe(0);
        expect((await readOutreach(outreachId)).delivery_status).toBe('rendered');
        expect(await readSendJobs(outreachId)).toHaveLength(0);
      });

      it('does not release while SOLICITATION_SEND_ENABLED is off', async () => {
        setEnv('SOLICITATION_SEND_ENABLED', 'false');
        const batch = await seedBatch(approvedBatchInput());
        await seedSendParent({ batch });
        await seedSolicitationPolicy(10);
        const { outreachId } = await seedOutreach({ batch });

        const report = await cycle();

        // The flag is the FIRST governor: cheapest, and it asks "does this
        // feature exist" before anything queries the database.
        expect(report.releasePhaseStoppedBy).toBe('flag_off');
        expect(report.released).toBe(0);
        expect((await readOutreach(outreachId)).delivery_status).toBe('rendered');
        expect(await readSendJobs(outreachId)).toHaveLength(0);
      });

      it('does not release while the Send breaker is open', async () => {
        await tripSendBreaker();
        const batch = await seedBatch(approvedBatchInput());
        await seedSendParent({ batch });
        await seedSolicitationPolicy(10);
        const { outreachId } = await seedOutreach({ batch });

        const report = await cycle();

        expect(report.releasePhaseStoppedBy).toBe('breaker_open');
        expect(report.released).toBe(0);
        expect((await readOutreach(outreachId)).delivery_status).toBe('rendered');
        expect(await readSendJobs(outreachId)).toHaveLength(0);
      });

      it('does not release when the platform daily ceiling is reached', async () => {
        const batch = await seedBatch(approvedBatchInput());
        await seedSendParent({ batch });
        await seedSolicitationPolicy(10);
        const { outreachId } = await seedOutreach({ batch });
        // Zero headroom: the cap equals what the platform has already dispatched
        // in this UTC day, which is the ceiling's "reached" state exactly.
        await setPlatformHeadroom(0);

        const report = await cycle();

        expect(report.releasePhaseStoppedBy).toBe('platform_ceiling');
        expect(report.released).toBe(0);
        expect((await readOutreach(outreachId)).delivery_status).toBe('rendered');
        expect(await readSendJobs(outreachId)).toHaveLength(0);
      });

      it('does not release beyond the account daily send cap', async () => {
        const batch = await seedBatch(approvedBatchInput());
        await seedSendParent({ batch });
        await seedSolicitationPolicy(1);
        // The cap counts DISPATCH ATTEMPTS by `queued_at` in the UTC day
        // (amendment B3), never `sent_at` — a bounce still spent reputation.
        // One attempt already made today exhausts a cap of one.
        await seedOutreach({
            batch,
            deliveryStatus: 'queued',
            queuedAgo: '5 minutes',
            queuedWithinUtcDay: true,
          });
        const { outreachId } = await seedOutreach({ batch });

        const report = await cycle();

        expect(report.released).toBe(0);
        expect(report.withheldByReason.account_cap).toBeGreaterThanOrEqual(1);
        // Per-ACCOUNT, so the phase itself still ran for other accounts.
        expect(report.releasePhaseStoppedBy).toBeNull();
        expect((await readOutreach(outreachId)).delivery_status).toBe('rendered');
        expect(await readSendJobs(outreachId)).toHaveLength(0);
      });

      it('keeps releasing for other accounts when a capped account fills the candidate scan', async () => {
        // Round-1 finding: P4 scans `ORDER BY approved_at ASC LIMIT scanLimit`
        // and the account cap is evaluated AFTER it, so before the
        // `capped_accounts` arm a capped account's batches held candidate slots
        // for their whole 72h send window while releasing nothing — and
        // oldest-first ordering favours exactly the accounts that have had the
        // most time to spend a daily cap. That is the locked edge case "no row
        // is skipped permanently" failing in the strongest way: the skipped row
        // is skipped until P2 cancels it.
        //
        // `scanLimit: 1` IS the scan window here, and the foreign batch's older
        // `approved_at` is what would take it.
        await seedCappedForeignCandidate();
        const batch = await seedBatch(approvedBatchInput());
        await seedSendParent({ batch });
        await seedSolicitationPolicy(10);
        const { outreachId } = await seedOutreach({ batch });

        const report = await cycle(sql(), { scanLimit: 1 });

        expect(report.released).toBe(1);
        // The capped account never became a candidate, so it consumed no scan
        // slot — but it IS counted. Round-2 finding: excluding it in SQL means
        // the per-account gate never runs for it, so before this counter a
        // fully cap-bound tick reported `withheldByReason: {}` and was
        // byte-identical to an idle tick, in the designed steady state (the cap
        // forces a 25-ask batch across ≥3 calendar days).
        expect(report.withheldByReason.account_cap).toBe(1);
        expect(report.releasePhaseStoppedBy).toBeNull();
        expect((await readOutreach(outreachId)).delivery_status).toBe('queued');
        expect(await readSendJobs(outreachId)).toHaveLength(1);
      });

      it('names the account cap on a tick where every candidate account is capped', async () => {
        // The other half of the same round-2 finding, and the one the staging
        // ramp actually reads: with NO releasable account left, the tick must
        // still say WHICH gate stopped it (the intake's observability bullet).
        // An idle tick reports `{}`; this one must not.
        await seedCappedForeignCandidate();

        const report = await cycle(sql(), { scanLimit: 1 });

        expect(report.released).toBe(0);
        expect(report.withheldByReason.account_cap).toBe(1);
        // Still a PER-ACCOUNT withhold, not a phase-level stop: the three
        // phase-level gates all passed, and another account could have released.
        expect(report.releasePhaseStoppedBy).toBeNull();
      });

      it('reports no withhold at all on a tick with no work due', async () => {
        // The control for the case above, and what makes that assertion mean
        // something: "nothing was due" must stay distinguishable from "something
        // was due and the cap withheld it".
        const report = await cycle();

        expect(report.released).toBe(0);
        expect(report.withheldByReason).toEqual({});
        expect(report.releasePhaseStoppedBy).toBeNull();
      });

      it('does not release when the subscription does not grant full access', async () => {
        // Invariant #11: entitlement is `subscriptionGrantsFullAccess`, never a
        // raw equality against 'active'. `past_due` is the case that separates
        // the two — it has a grace window elsewhere, and none here.
        await setSubscriptionStatus('past_due');
        const batch = await seedBatch(approvedBatchInput());
        await seedSendParent({ batch });
        await seedSolicitationPolicy(10);
        const { outreachId } = await seedOutreach({ batch });

        const report = await cycle();

        expect(report.released).toBe(0);
        expect(report.withheldByReason.subscription).toBeGreaterThanOrEqual(1);
        // A lapsed subscription is RECOVERABLE inside the send window: the row
        // stays `rendered` so paying resumes the drip with no intervention.
        expect((await readOutreach(outreachId)).delivery_status).toBe('rendered');
        expect(await readSendJobs(outreachId)).toHaveLength(0);
      });

      it(
        'evaluates the governors in the fixed order breaker then platform ceiling then account cap then subscription',
        async () => {
          // THE ORDER IS THE ASSERTION, not that each gate works alone. Amendment
          // B6's closing paragraph fixes it, and a wrong order is SILENT (#910
          // B3.2) — every gate still refuses, only the reported reason lies, and
          // the operator chases the wrong dial. So each round below seeds a state
          // where EVERY REMAINING gate would fire and asserts the FIRST one is
          // the one reported.
          const batch = await seedBatch(approvedBatchInput());
          await seedSendParent({ batch });
          await seedSolicitationPolicy(1);
          await seedOutreach({
            batch,
            deliveryStatus: 'queued',
            queuedAgo: '5 minutes',
            queuedWithinUtcDay: true,
          });
          const { outreachId } = await seedOutreach({ batch });
          await setSubscriptionStatus('past_due');
          await setPlatformHeadroom(0);
          const tripId = await tripSendBreaker();

          // 1. breaker + ceiling + cap + subscription all fire → breaker wins.
          expect((await cycle()).releasePhaseStoppedBy).toBe('breaker_open');

          // 2. ceiling + cap + subscription fire → ceiling wins.
          await sql()`
            UPDATE solicitation_send_breaker
            SET reset_at = NOW(), reset_by = ${userId()}::uuid, reset_note = 'order fixture'
            WHERE id = ${tripId}::uuid
          `;
          expect((await cycle()).releasePhaseStoppedBy).toBe('platform_ceiling');

          // 3. cap + subscription fire → the ACCOUNT CAP is reported, and the
          //    subscription is not. B6's per-child list numbers subscription
          //    ahead of the caps; that is a DIFFERENT list and does not govern
          //    the release level. This assertion is the whole difference.
          await setPlatformHeadroom(1_000);
          const capRound = await cycle();
          expect(capRound.releasePhaseStoppedBy).toBeNull();
          expect(capRound.withheldByReason.account_cap).toBeGreaterThanOrEqual(1);
          expect(capRound.withheldByReason.subscription).toBeUndefined();

          // 4. only the subscription fires → subscription is reported.
          await sql()`
            UPDATE auto_approval_policies SET daily_send_cap = 10
            WHERE account_id = ${accountId()}::uuid AND persona = 'solicitation'
          `;
          const subscriptionRound = await cycle();
          expect(subscriptionRound.withheldByReason.subscription).toBeGreaterThanOrEqual(1);
          expect(subscriptionRound.withheldByReason.account_cap).toBeUndefined();

          // Nothing released in any of the four rounds.
          expect((await readOutreach(outreachId)).delivery_status).toBe('rendered');
          expect(await readSendJobs(outreachId)).toHaveLength(0);
        },
      );

      it('stamps sending_started_at on the first release only', async () => {
        // Decision 6: stamped in the FIRST release transaction, CAS on NULL. It
        // is the boundary between "a Judge outage may return this batch to the
        // owner" and "a Judge outage may only hold it", so a second stamp would
        // move a batch back across a line it has already crossed.
        const batch = await seedBatch(approvedBatchInput());
        await seedSendParent({ batch });
        await seedSolicitationPolicy(10);
        await seedOutreach({ batch });
        await seedOutreach({ batch });

        const first = await cycle(sql(), { perTickBudget: 1 });
        expect(first.released).toBe(1);
        const afterFirst = await readBatch(batch.batchId);
        expect(afterFirst.sending_started_at).not.toBeNull();

        const second = await cycle(sql(), { perTickBudget: 1 });
        expect(second.released).toBe(1);
        const afterSecond = await readBatch(batch.batchId);
        expect(afterSecond.sending_started_at?.getTime()).toBe(
          afterFirst.sending_started_at?.getTime(),
        );
      });

      it('releases at most the per-tick budget and leaves the rest for the next tick', async () => {
        // The drip's pacing lever (decision 7). No row is skipped permanently —
        // the remainder is simply next tick's work.
        const batch = await seedBatch(approvedBatchInput());
        await seedSendParent({ batch });
        await seedSolicitationPolicy(10);
        const rows = [
          await seedOutreach({ batch }),
          await seedOutreach({ batch }),
          await seedOutreach({ batch }),
        ];

        const first = await cycle(sql(), { perTickBudget: 2 });

        expect(first.released).toBe(2);
        expect(first.withheldByReason.per_tick_budget).toBeGreaterThanOrEqual(1);
        const statuses = await Promise.all(
          rows.map(async (row) => (await readOutreach(row.outreachId)).delivery_status),
        );
        expect(statuses.filter((status) => status === 'queued')).toHaveLength(2);
        expect(statuses.filter((status) => status === 'rendered')).toHaveLength(1);

        const second = await cycle(sql(), { perTickBudget: 2 });
        expect(second.released).toBe(1);
        expect(await readSendJobs()).toHaveLength(3);
      });

      it('a second release attempt for the same Outreach row inserts no second outbox row', async () => {
        const batch = await seedBatch(approvedBatchInput());
        await seedSendParent({ batch });
        await seedSolicitationPolicy(10);
        const { outreachId } = await seedOutreach({ batch });

        expect((await cycle()).released).toBe(1);
        expect(await readSendJobs(outreachId)).toHaveLength(1);

        // A second tick finds no `rendered` row, so it enqueues nothing.
        expect((await cycle()).released).toBe(0);
        expect(await readSendJobs(outreachId)).toHaveLength(1);

        // AND the database itself refuses a duplicate, which is the guarantee
        // that survives a caller who skips the CAS: migration 091's
        // `job_outbox_solicitation_send_inflight` is the second belt behind the
        // rendered→queued CAS. Probed in a savepoint so the rejection does not
        // poison anything else.
        await expect(
          sql().begin(async (tx) => {
            await tx`
              INSERT INTO job_outbox (id, topic, aggregate_type, aggregate_id, payload, status)
              VALUES (
                ${randomUUID()}::uuid, ${QUEUE_NAMES.SOLICITATION_SEND},
                'solicitation_outreach', ${outreachId}::uuid,
                ${tx.json({
                  outreach_id: outreachId,
                  batch_id: batch.batchId,
                  business_id: batch.businessId,
                })},
                'pending'
              )
            `;
          }),
        ).rejects.toMatchObject({ code: '23505' });
        expect(await readSendJobs(outreachId)).toHaveLength(1);
      });

      it('never releases an approved batch with a NULL veto_deadline_at', async () => {
        // D9 FAIL-CLOSED: no deadline means never released. A batch approved
        // through a path that forgot to stamp one must sit until the 72h sweep
        // terminalizes it — it must NOT be treated as "deadline already past".
        const batch = await seedBatch(
          approvedBatchInput({ vetoDeadlineAgo: undefined }),
        );
        await seedSendParent({ batch });
        await seedSolicitationPolicy(10);
        const { outreachId } = await seedOutreach({ batch });

        const report = await cycle();

        expect(report.released).toBe(0);
        expect((await readOutreach(outreachId)).delivery_status).toBe('rendered');
        expect(await readSendJobs(outreachId)).toHaveLength(0);
        // Still approved: a missing deadline is not grounds for a downgrade.
        const after = await readBatch(batch.batchId);
        expect(after.approved_at).not.toBeNull();
        expect(after.veto_deadline_at).toBeNull();
      });

      it('releases no more than the remaining platform capacity in one tick', async () => {
        // Round-1 finding 11. A single check at the top of the phase lets a
        // budget-two tick overrun a ceiling with ONE slot left; the remainder
        // has to decrement on every successful release.
        const batch = await seedBatch(approvedBatchInput());
        await seedSendParent({ batch });
        await seedSolicitationPolicy(10);
        const rows = [
          await seedOutreach({ batch }),
          await seedOutreach({ batch }),
          await seedOutreach({ batch }),
        ];
        await setPlatformHeadroom(1);

        const report = await cycle(sql(), { perTickBudget: 2 });

        expect(report.released).toBe(1);
        expect(report.withheldByReason.platform_ceiling).toBeGreaterThanOrEqual(1);
        const statuses = await Promise.all(
          rows.map(async (row) => (await readOutreach(row.outreachId)).delivery_status),
        );
        expect(statuses.filter((status) => status === 'queued')).toHaveLength(1);
        expect(statuses.filter((status) => status === 'rendered')).toHaveLength(2);
        expect(await readSendJobs()).toHaveLength(1);
      });
    });

    // ── the Judge split (D18) ───────────────────────────────────────────────

    describe('the Judge availability split', () => {
      it(
        'downgrades an approved batch to owner review when the Judge is unhealthy before the first release',
        async () => {
          spies.isJudgeHealthy.mockResolvedValue(false);
          const batch = await seedBatch(approvedBatchInput());
          const parentRunId = await seedSendParent({ batch });
          await seedSolicitationPolicy(10);
          const { outreachId } = await seedOutreach({ batch });

          const report = await cycle();

          expect(report.downgraded).toBe(1);
          expect(report.released).toBe(0);

          // The batch reappears as approvable in the Requests panel: every
          // approval column is cleared together, or the panel shows a batch it
          // cannot act on.
          const after = await readBatch(batch.batchId);
          expect(after.approved_at).toBeNull();
          expect(after.approval_method).toBeNull();
          expect(after.approved_by_user_id).toBeNull();
          expect(after.veto_deadline_at).toBeNull();
          expect(after.halted_at).toBeNull();

          // A spine step plus a Sentry warning is the WHOLE record — no owner
          // notification (locked decision 4).
          const steps = await readSteps(parentRunId, 'approval_downgraded');
          expect(steps).toHaveLength(1);
          expect(jsonObject(steps[0]!.detail)).toMatchObject({ reason: 'judge_unavailable' });

          expect((await readOutreach(outreachId)).delivery_status).toBe('rendered');
          expect(await readSendJobs(outreachId)).toHaveLength(0);
        },
      );

      it('holds with no state change when the Judge is unhealthy mid-drip', async () => {
        // Mid-drip is `sending_started_at IS NOT NULL`, and 091's
        // `solicitation_batches_send_ordering` CHECK makes a downgrade there
        // impossible at the database. The correct behaviour is a HOLD: no
        // writes at all, so releases resume on recovery — or the 72h window
        // expires and the batch terminalizes cancelled.
        spies.isJudgeHealthy.mockResolvedValue(false);
        const batch = await seedBatch(
          approvedBatchInput({ sendingStartedAgo: '30 minutes' }),
        );
        const parentRunId = await seedSendParent({ batch });
        await seedSolicitationPolicy(10);
        await seedOutreach({ batch, deliveryStatus: 'sent' });
        const { outreachId } = await seedOutreach({ batch });
        const before = await readBatch(batch.batchId);

        const report = await cycle();

        expect(report.heldForJudge).toBe(1);
        expect(report.downgraded).toBe(0);
        expect(report.released).toBe(0);
        expect(await readBatch(batch.batchId)).toEqual(before);
        expect(await readSteps(parentRunId)).toHaveLength(0);
        expect((await readOutreach(outreachId)).delivery_status).toBe('rendered');
        expect(await readSendJobs(outreachId)).toHaveLength(0);
      });

      it('treats JUDGE_ENABLED false exactly as an unhealthy Judge', async () => {
        // D18 requires BOTH reads to fail closed. The health probe is left
        // HEALTHY here on purpose: if the flag were ignored, this batch would
        // release, and the case would be the only thing standing between a
        // switched-off Judge and unreviewed auto-sends.
        setEnv('JUDGE_ENABLED', 'false');
        spies.isJudgeHealthy.mockResolvedValue(true);
        const batch = await seedBatch(approvedBatchInput());
        const parentRunId = await seedSendParent({ batch });
        await seedSolicitationPolicy(10);
        const { outreachId } = await seedOutreach({ batch });

        const report = await cycle();

        expect(report.downgraded).toBe(1);
        expect(report.released).toBe(0);
        const after = await readBatch(batch.batchId);
        expect(after.approved_at).toBeNull();
        expect(after.approval_method).toBeNull();
        const steps = await readSteps(parentRunId, 'approval_downgraded');
        expect(steps).toHaveLength(1);
        expect(jsonObject(steps[0]!.detail)).toMatchObject({ reason: 'judge_unavailable' });
        expect((await readOutreach(outreachId)).delivery_status).toBe('rendered');
      });

      it('holds instead of downgrading when the batch can no longer be re-approved', async () => {
        // Round-1 finding. A downgrade's whole promise is the one
        // `user_visible_behavior` states — the batch reappears as APPROVABLE.
        // Past `built_at` + the 7-day approval window that promise is false:
        // **Batch state** reads `expired`, `approveBatch` refuses it (D2), and
        // P3 latches it `batch_expired` on the very next tick — an
        // owner-approved batch destroyed with no notification on either step.
        // Holding leaves it to P2's honest `send_window_elapsed` instead.
        spies.isJudgeHealthy.mockResolvedValue(false);
        const batch = await seedBatch(approvedBatchInput({ builtAgo: '8 days' }));
        const parentRunId = await seedSendParent({ batch });
        await seedSolicitationPolicy(10);
        const { outreachId } = await seedOutreach({ batch });
        const before = await readBatch(batch.batchId);

        const report = await cycle();

        expect(report.heldForJudge).toBe(1);
        expect(report.downgraded).toBe(0);
        expect(report.released).toBe(0);
        // A hold writes nothing and takes no lock.
        expect(await readBatch(batch.batchId)).toEqual(before);
        expect(await readSteps(parentRunId, 'approval_downgraded')).toHaveLength(0);
        expect((await readOutreach(outreachId)).delivery_status).toBe('rendered');
      });

      it('does not downgrade a cap-exhausted batch when the Judge is unhealthy', async () => {
        // Round-1 finding 2, and the reason the Judge is evaluated LAST. A
        // downgrade is DESTRUCTIVE — it erases the owner's approval evidence —
        // so it may only fire for a batch that has passed every other gate and
        // still has capacity. Evaluating it before the account cap would throw
        // away the approval of a batch the cap alone would simply have paused.
        spies.isJudgeHealthy.mockResolvedValue(false);
        const batch = await seedBatch(approvedBatchInput());
        const parentRunId = await seedSendParent({ batch });
        await seedSolicitationPolicy(1);
        await seedOutreach({
            batch,
            deliveryStatus: 'queued',
            queuedAgo: '5 minutes',
            queuedWithinUtcDay: true,
          });
        const { outreachId } = await seedOutreach({ batch });

        const report = await cycle();

        expect(report.downgraded).toBe(0);
        expect(report.withheldByReason.account_cap).toBeGreaterThanOrEqual(1);
        const after = await readBatch(batch.batchId);
        expect(after.approved_at).not.toBeNull();
        expect(after.approval_method).toBe('owner');
        expect(after.approved_by_user_id).toBe(userId());
        expect(await readSteps(parentRunId, 'approval_downgraded')).toHaveLength(0);
        expect((await readOutreach(outreachId)).delivery_status).toBe('rendered');
      });
    });

    // ── the two system Halt latch sweeps ────────────────────────────────────

    describe('the send-window and approval-window sweeps', () => {
      it(
        'latches send_window_elapsed past the 72h send window and cancels the live Outreach rows',
        async () => {
          // Strictly past the boundary by 419 microseconds so a JS round-trip of
          // the stamp cannot round it back onto the edge (#520).
          const batch = await seedBatch({
            builtAgo: '80 hours',
            approvedAgo: '72 hours 419 microseconds',
            approvalMethod: 'owner',
            vetoDeadlineAgo: '71 hours',
            sendingStartedAgo: '70 hours',
          });
          const parentRunId = await seedSendParent({ batch, startedAgo: '73 hours' });
          const rendered = await seedOutreach({ batch });
          const queued = await seedOutreach({
            batch,
            deliveryStatus: 'queued',
            queuedAgo: '69 hours',
          });
          const sending = await seedOutreach({
            batch,
            deliveryStatus: 'sending',
            queuedAgo: '69 hours',
            sendingAgo: '68 hours',
          });

          const report = await cycle();

          expect(report.sendWindowElapsed).toBe(1);
          // The breaker is CLOSED in this case (afterEach empties the table), so
          // the sweep takes its blander arm and the platform counter stays at
          // zero. The two counters are fed by ONE sweep (#917), so asserting
          // both is what proves the arms are exclusive rather than additive.
          expect(report.platformHalted).toBe(0);
          const after = await readBatch(batch.batchId);
          expect(after.halted_at).not.toBeNull();
          expect(after.halt_reason).toBe('send_window_elapsed');
          // 091's halt-consistency CHECK, widened by 111, requires halted_by IS
          // NULL for exactly the three SYSTEM reasons — the type says what the
          // database enforces.
          expect(after.halted_by).toBeNull();

          expect(await readOutreach(rendered.outreachId)).toMatchObject({
            delivery_status: 'cancelled',
            disposition_reason: 'send_window_elapsed',
          });
          expect(await readOutreach(queued.outreachId)).toMatchObject({
            delivery_status: 'cancelled',
            disposition_reason: 'send_window_elapsed',
          });
          // NEVER `cancelled`: that row is past the point of no return, and
          // halt means "no further sends", not "undo" — D10 excludes `sending`
          // from the halt sweep on purpose.
          //
          // It "resolves itself" through PHASE 1, not by being left alone, and
          // this fixture is D12d's own example: the row has sat `sending` for
          // 68 hours with no in-flight outbox row, so the `unknown` sweep — which
          // runs FIRST and carries no batch predicate — terminalizes it in the
          // same tick. That escape is exactly what D12d says it is for: without
          // it a wedged `sending` row blocks `closeBatchIfSettled` forever and
          // permanently consumes the location's one active-send slot.
          //
          // (Asserted as `sending` until Task 6 built the sweep, when this
          // interaction became reachable — see the deviations file.)
          expect(await readOutreach(sending.outreachId)).toMatchObject({
            delivery_status: 'unknown',
            disposition_reason: 'send_indeterminate',
          });

          const steps = await readSteps(parentRunId, 'batch_halted');
          expect(steps).toHaveLength(1);
          expect(jsonObject(steps[0]!.detail)).toMatchObject({
            halt_reason: 'send_window_elapsed',
            halted_by: null,
          });
        },
      );

      it(
        'latches platform_halt instead of send_window_elapsed while the Send breaker is open',
        async () => {
          // #917. THE SAME FIXTURE as the case above, with ONE difference: the
          // breaker is open. Same 72h clock, same predicate, same sweep — only
          // the reason changes. If this test ever needs a different `approvedAgo`
          // to fire, the fix has grown a second window and the ticket's decision
          // (a truer reason, not a halt-aware window) has been quietly reversed.
          await tripSendBreaker();

          const batch = await seedBatch({
            builtAgo: '80 hours',
            approvedAgo: '72 hours 419 microseconds',
            approvalMethod: 'owner',
            vetoDeadlineAgo: '71 hours',
            sendingStartedAgo: '70 hours',
          });
          const parentRunId = await seedSendParent({ batch, startedAgo: '73 hours' });
          const rendered = await seedOutreach({ batch });
          const queued = await seedOutreach({
            batch,
            deliveryStatus: 'queued',
            queuedAgo: '69 hours',
          });

          const report = await cycle();

          // The sweep RAN — B14's rejected alternative was to suppress it while
          // the breaker is open, which blows past the <=10-day bound
          // STALLED_THRESHOLD_SEND_BATCH_DAYS = 11 derives from. A zero here
          // would mean that alternative had been taken by accident.
          expect(report.platformHalted).toBe(1);
          expect(report.sendWindowElapsed).toBe(0);

          const after = await readBatch(batch.batchId);
          expect(after.halted_at).not.toBeNull();
          expect(after.halt_reason).toBe('platform_halt');
          // 111 added `platform_halt` to the CHECK's reason list and NOT to its
          // actor list, so this is a database-enforced fact, not a convention.
          expect(after.halted_by).toBeNull();

          // The write-through: `latchHalt` stamps the batch's halt reason on
          // every cancelled Outreach row, so 111 had to widen the outreach
          // CHECK's cancelled arm too or this latch would raise a 23514
          // mid-transaction and the batch would never terminalize at all.
          expect(await readOutreach(rendered.outreachId)).toMatchObject({
            delivery_status: 'cancelled',
            disposition_reason: 'platform_halt',
          });
          expect(await readOutreach(queued.outreachId)).toMatchObject({
            delivery_status: 'cancelled',
            disposition_reason: 'platform_halt',
          });

          const steps = await readSteps(parentRunId, 'batch_halted');
          expect(steps).toHaveLength(1);
          expect(jsonObject(steps[0]!.detail)).toMatchObject({
            halt_reason: 'platform_halt',
            halted_by: null,
          });
        },
      );

      it(
        'falls back to send_window_elapsed when the breaker probe throws, and still sweeps',
        async () => {
          // The label-only carve-out (#917). A rethrow here would stop the sweep
          // and leave the batch's `rendered`/`queued` rows alive, which is the
          // permanent wedge #915 closed: 091's one-active-send index then blocks
          // that location forever. So the probe failure costs a LABEL, never the
          // sweep — and the fallback is the reason that CLAIMS LESS, because an
          // unproven accusation against the platform is worse than a bland one.
          //
          // Phase 4's own `readSendBreaker` still has no try/catch, so the tick
          // as a whole still fails closed on SENDING. That is asserted by the
          // sibling case 'propagates a Send breaker read failure…' below; here
          // the assertion is only that phase 2 completed first.
          spies.readSendBreaker.mockRejectedValue(new Error('breaker probe: connection reset'));

          const batch = await seedBatch({
            builtAgo: '80 hours',
            approvedAgo: '72 hours 419 microseconds',
            approvalMethod: 'owner',
            vetoDeadlineAgo: '71 hours',
            sendingStartedAgo: '70 hours',
          });
          await seedSendParent({ batch, startedAgo: '73 hours' });
          const rendered = await seedOutreach({ batch });

          // The cycle still aborts — phase 4's gate is untouched — so the sweep's
          // effect has to be read off the database rather than off the report.
          await expect(cycle()).rejects.toThrow('breaker probe: connection reset');

          const after = await readBatch(batch.batchId);
          expect(after.halt_reason).toBe('send_window_elapsed');
          expect(after.halted_by).toBeNull();
          expect(await readOutreach(rendered.outreachId)).toMatchObject({
            delivery_status: 'cancelled',
            disposition_reason: 'send_window_elapsed',
          });
        },
      );

      it('migration 111 admits platform_halt in BOTH CHECKs, and in neither actor list', async () => {
        // The honest proof that 111 is applied. A `SchemaRequirement` cannot
        // carry it: both constraint NAMES have existed since 091, so presence is
        // satisfied by a database three migrations behind head — the trap
        // `MIGRATION_110_SEND_GOVERNORS`'s docstring describes. The DEFINITION is
        // the only distinguishing fact.
        const [batchCheck] = await sql()<{ definition: string }[]>`
          SELECT pg_get_constraintdef(oid) AS definition
            FROM pg_constraint
           WHERE conname = 'solicitation_batches_halt_consistency'
        `;
        const [outreachCheck] = await sql()<{ definition: string }[]>`
          SELECT pg_get_constraintdef(oid) AS definition
            FROM pg_constraint
           WHERE conname = 'solicitation_outreach_status_reason_consistency'
        `;

        expect(batchCheck?.definition).toContain('platform_halt');
        expect(outreachCheck?.definition).toContain('platform_halt');

        // The ACTOR arm must NOT have grown it. This is the assertion that
        // distinguishes 111 from a careless widening: adding `platform_halt` to
        // the actor list would let a clock be filed as a person, and every other
        // test here would still pass.
        const actorArm = /halted_by IS NOT NULL[\s\S]*?\)\s*IS TRUE/.exec(
          batchCheck?.definition ?? '',
        );
        expect(actorArm?.[0] ?? '').not.toContain('platform_halt');
      });

      it(
        'latches batch_expired on a never-approved batch past the approval window and closes its parent',
        async () => {
          const batch = await seedBatch({ builtAgo: '7 days 419 microseconds' });
          const parentRunId = await seedSendParent({ batch, startedAgo: '7 days' });
          const rendered = await seedOutreach({ batch });

          const report = await cycle();

          expect(report.batchExpired).toBe(1);
          const after = await readBatch(batch.batchId);
          expect(after.halt_reason).toBe('batch_expired');
          expect(after.halted_by).toBeNull();
          expect(after.send_closed_at).not.toBeNull();

          expect(await readOutreach(rendered.outreachId)).toMatchObject({
            delivery_status: 'cancelled',
            disposition_reason: 'batch_expired',
          });

          // Halt NEVER terminalizes the parent directly — `closeBatchIfSettled`
          // is its single owner, reached through the latch's join.
          expect((await readRun(parentRunId)).status).toBe('cancelled');
          expect(await readSteps(parentRunId, 'batch_halted')).toHaveLength(1);
          expect(await readSteps(parentRunId, 'send_batch_closed')).toHaveLength(1);
        },
      );

      it('a batch that receives no approval for 7 days closes cleanly and raises no stalled alert', async () => {
        // B7's stated obligation. `deriveRunDisplayState` calls a send parent
        // STALLED at 11 days, so the 7-day sweep exists precisely to make that
        // threshold unreachable for an unapproved batch. Asserting only "the
        // parent is cancelled" would pass for a sweep that fired on day 12.
        const batch = await seedBatch({ builtAgo: '7 days 1 hour' });
        const parentRunId = await seedSendParent({ batch, startedAgo: '7 days 1 hour' });
        await seedOutreach({ batch });

        const report = await cycle();

        expect(report.batchExpired).toBe(1);
        const parent = await readRun(parentRunId);
        expect(parent.status).toBe('cancelled');
        expect(parent.ended_at).not.toBeNull();
        const ageAtCloseMs = parent.ended_at!.getTime() - parent.started_at.getTime();
        expect(ageAtCloseMs).toBeLessThan(
          STALLED_THRESHOLD_SEND_BATCH_DAYS * 24 * 60 * 60 * 1000,
        );
        expect((await readBatch(batch.batchId)).send_closed_at).not.toBeNull();
      });

      it('does not latch batch_expired on a batch with no Send batch parent', async () => {
        // RE-VERIFIED by Task 5, 2026-08-22, and no longer vacuous: with P3's
        // `EXISTS` arm deleted this case is the ONLY one in the file that goes
        // RED (`expected 1 to be +0` — the watch-mode batch WAS latched), and it
        // goes green again the moment the arm is restored.
        // B7's `EXISTS` over `agent_runs` is what "that have a Send batch
        // parent" means. Without it a WATCH-MODE batch — built, never sent, no
        // send lane at all — is latched with a reason describing a lane it was
        // never in.
        const batch = await seedBatch({ builtAgo: '9 days' });
        const rendered = await seedOutreach({ batch });

        const report = await cycle();

        expect(report.batchExpired).toBe(0);
        const after = await readBatch(batch.batchId);
        expect(after.halted_at).toBeNull();
        expect(after.halt_reason).toBeNull();
        expect((await readOutreach(rendered.outreachId)).delivery_status).toBe('rendered');
      });
    });

    // ── the `unknown` sweep (D12d, the #915 blocker) ────────────────────────

    describe('the unknown sweep', () => {
      it(
        'terminalizes a sending Outreach row as unknown after the grace period when no in-flight outbox row exists',
        async () => {
          const batch = await seedBatch(
            wedgedBatchInput(),
          );
          await seedSendParent({ batch });
          const sending = await seedOutreach({
            batch,
            deliveryStatus: 'sending',
            queuedAgo: '65 minutes',
            sendingAgo: '60 minutes 419 microseconds',
          });
          const childRunId = await seedLazyChild(sending.askId, batch.businessId);
          await attachLazyChild(sending.outreachId, childRunId);

          const report = await cycle();

          expect(report.unknownTerminalized).toBe(1);
          // 091 pairs `unknown` and `send_indeterminate` exclusively — never
          // spell either alone. `failed` here would be the lie with teeth: the
          // restraint policy's `over_contacted` check reads prior sends, so
          // calling a possible send "not sent" can email that customer twice.
          expect(await readOutreach(sending.outreachId)).toMatchObject({
            delivery_status: 'unknown',
            disposition_reason: 'send_indeterminate',
          });
          // `unknown` is NOT a confirmed send for metrics (D12d).
          expect(await countOutcomes(childRunId, 'solicitation_sent')).toBe(0);
        },
      );

      it('does not terminalize a sending row while an in-flight outbox row still exists', async () => {
        // RE-VERIFIED by Task 6, 2026-08-22, and no longer vacuous — but the
        // probe found the belts are NOT independently pinned by this case, and
        // the finding is recorded here rather than left to be rediscovered.
        // Deleting P1's outer `NOT EXISTS` ALONE leaves this GREEN: the outbox
        // row is seeded before the cycle, so the belt REPEATED INSIDE THE CAS
        // still refuses it. Deleting the CAS belt alone also leaves it green,
        // for the mirror reason. It goes RED — `expected 1 to be +0`, the row
        // WAS terminalized — only when BOTH belts are deleted, and green again
        // the moment either is restored. So this case pins the PAIR; the case
        // below is what pins the CAS belt on its own.
        // Both belts. The grace period alone is not sufficient evidence of a
        // wedge: a job the OutboxPoller is still carrying is a normal delivery
        // in progress, and terminalizing it would race a real provider send.
        const batch = await seedBatch(
          wedgedBatchInput(),
        );
        await seedSendParent({ batch });
        const sending = await seedOutreach({
          batch,
          deliveryStatus: 'sending',
          queuedAgo: '65 minutes',
          sendingAgo: '61 minutes',
        });
        const childRunId = await seedLazyChild(sending.askId, batch.businessId);
        await attachLazyChild(sending.outreachId, childRunId);
        await seedInFlightSendJob(sending.outreachId, batch, 'dispatched');

        const report = await cycle();

        expect(report.unknownTerminalized).toBe(0);
        expect((await readOutreach(sending.outreachId)).delivery_status).toBe('sending');
        expect((await readRun(childRunId)).status).toBe('running');
      });

      it(
        'terminalizes the lazy child run in the same transaction as the unknown outreach row',
        async () => {
          // Round-1 finding 6, confirmed at src/lib/solicitation/dispatch.ts:1752:
          // the **Lazy child** is minted in tx1 BEFORE the `sending` CAS, so a
          // process that died between tx1 and tx2 left BOTH rows behind.
          // Terminalizing only the Outreach row leaves the child `running`
          // forever, which trips `deriveRunDisplayState`'s 48h stalled rule and
          // re-opens the wedge from the spine side.
          const batch = await seedBatch(
            wedgedBatchInput(),
          );
          await seedSendParent({ batch });
          const sending = await seedOutreach({
            batch,
            deliveryStatus: 'sending',
            queuedAgo: '65 minutes',
            sendingAgo: '61 minutes',
          });
          const childRunId = await seedLazyChild(sending.askId, batch.businessId);
          await attachLazyChild(sending.outreachId, childRunId);

          const report = await cycle();

          expect(report.unknownTerminalized).toBe(1);
          expect((await readOutreach(sending.outreachId)).delivery_status).toBe('unknown');

          // `failed` on the CHILD RUN is not the lie D12d forbids — that lie is
          // about `solicitation_outreach.delivery_status`, which the restraint
          // policy reads. Nothing reads `agent_runs` for over-contact.
          const child = await readRun(childRunId);
          expect(child.status).toBe('failed');
          expect(child.ended_at).not.toBeNull();
          expect(jsonObject(child.error)).toMatchObject({ code: 'send_indeterminate' });
          expect(await countOutcomes(childRunId, 'solicitation_sent')).toBe(0);
        },
      );

      it('does not terminalize a sending row whose outbox row is re-pended after selection', async () => {
        // RE-VERIFIED by Task 6, 2026-08-22, and no longer vacuous: with the
        // `NOT EXISTS` REPEATED INSIDE the CAS deleted, this is the ONLY case in
        // the file that goes RED (`expected 1 to be +0` — the re-pended row WAS
        // terminalized), and it goes green again the moment that belt is
        // restored. P1's outer belt is irrelevant here BY CONSTRUCTION: the
        // re-pend lands after the unlocked selection, so the outer belt never
        // sees it, and deleting the outer belt alone leaves this case green.
        // This case is therefore the CAS belt's sole pin.
        // Round-1 finding 5. P1 runs OUTSIDE the terminalizing transaction, so
        // the outbox watchdog can re-pend the row between the select and the
        // UPDATE. A `delivery_status = 'sending'` guard alone would then write
        // `unknown` over a normal recovery in flight — which is why the
        // `NOT EXISTS` is repeated inside the CAS.
        const batch = await seedBatch(
          wedgedBatchInput(),
        );
        await seedSendParent({ batch });
        const sending = await seedOutreach({
          batch,
          deliveryStatus: 'sending',
          queuedAgo: '65 minutes',
          sendingAgo: '61 minutes',
        });
        const childRunId = await seedLazyChild(sending.askId, batch.businessId);
        await attachLazyChild(sending.outreachId, childRunId);

        // The watchdog's re-pend, injected at the top of the sweep's own
        // transaction — after the unlocked selection, before the CAS.
        const watchdog = precedingExecutor(sql(), (tx) => tx`
          INSERT INTO job_outbox (id, topic, aggregate_type, aggregate_id, payload, status)
          VALUES (
            ${randomUUID()}::uuid, ${QUEUE_NAMES.SOLICITATION_SEND},
            'solicitation_outreach', ${sending.outreachId}::uuid,
            ${tx.json({
              outreach_id: sending.outreachId,
              batch_id: batch.batchId,
              business_id: batch.businessId,
            })},
            'pending'
          )
          ON CONFLICT DO NOTHING
        `);

        const report = await cycle(watchdog);

        expect(report.unknownTerminalized).toBe(0);
        expect((await readOutreach(sending.outreachId)).delivery_status).toBe('sending');
        expect((await readRun(childRunId)).status).toBe('running');
      });
    });

    // ── the flag scope and the backstop join ────────────────────────────────

    describe('the flag scope and the backstop join', () => {
      it('runs the sweeps and the backstop while SOLICITATION_SEND_ENABLED is off', async () => {
        // Locked decision 8, and the whole reason the flag gates PHASE 4 ONLY.
        // If the flag gated the cycle, flipping it off mid-drip would stop the
        // `send_window_elapsed` sweep, and 091's one-active-send index would
        // block that location forever — the permanent wedge #915 exists to
        // close. Each of the three phases below lives on its OWN location
        // because that index admits one open approved batch per business.
        setEnv('SOLICITATION_SEND_ENABLED', 'false');

        const elapsed = await seedBatch({
          onBusinessId: businessId,
          builtAgo: '80 hours',
          approvedAgo: '72 hours 419 microseconds',
          approvalMethod: 'owner',
          vetoDeadlineAgo: '71 hours',
          sendingStartedAgo: '70 hours',
        });
        await seedSendParent({ batch: elapsed, startedAgo: '73 hours' });
        await seedOutreach({ batch: elapsed });

        const expired = await seedBatch({
          onBusinessId: businessId,
          builtAgo: '8 days',
        });
        await seedSendParent({ batch: expired, startedAgo: '8 days' });
        await seedOutreach({ batch: expired });

        const wedged = await seedBatch({
          onBusinessId: siblingBusinessId,
          ...wedgedBatchInput(),
        });
        await seedSendParent({ batch: wedged });
        const sending = await seedOutreach({
          batch: wedged,
          deliveryStatus: 'sending',
          queuedAgo: '65 minutes',
          sendingAgo: '61 minutes',
        });
        await attachLazyChild(
          sending.outreachId,
          await seedLazyChild(sending.askId, wedged.businessId),
        );

        const settled = await seedBatch({
          onBusinessId: thirdBusinessId,
          ...approvedBatchInput({ sendingStartedAgo: '30 minutes' }),
        });
        const settledParentRunId = await seedSendParent({ batch: settled });
        await seedOutreach({ batch: settled, deliveryStatus: 'sent' });

        const report = await cycle();

        expect(report.releasePhaseStoppedBy).toBe('flag_off');
        expect(report.released).toBe(0);
        // …and every other phase still ran.
        expect(report.sendWindowElapsed).toBe(1);
        expect(report.batchExpired).toBe(1);
        expect(report.unknownTerminalized).toBe(1);
        expect(report.backstopClosed).toBeGreaterThanOrEqual(1);

        expect((await readBatch(elapsed.batchId)).halt_reason).toBe('send_window_elapsed');
        expect((await readBatch(expired.batchId)).halt_reason).toBe('batch_expired');
        expect((await readOutreach(sending.outreachId)).delivery_status).toBe('unknown');
        expect((await readBatch(settled.batchId)).send_closed_at).not.toBeNull();
        expect((await readRun(settledParentRunId)).status).toBe('completed');
      });

      it('closes a settled batch the inline path missed', async () => {
        // D11: ONE implementation of the join, two callers. The inline caller is
        // the send worker's terminal transaction; this is the backstop for the
        // tick where that call was lost — a crash between the terminal CAS and
        // the join. No second implementation.
        const batch = await seedBatch(approvedBatchInput({ sendingStartedAgo: '30 minutes' }));
        const parentRunId = await seedSendParent({ batch });
        await seedOutreach({ batch, deliveryStatus: 'sent' });
        await seedOutreach({
          batch,
          deliveryStatus: 'withheld',
          dispositionReason: 'suppressed',
        });

        const report = await cycle();

        expect(report.backstopClosed).toBe(1);
        expect((await readBatch(batch.batchId)).send_closed_at).not.toBeNull();
        const parent = await readRun(parentRunId);
        expect(parent.status).toBe('completed');
        const steps = await readSteps(parentRunId, 'send_batch_closed');
        expect(steps).toHaveLength(1);
        expect(jsonObject(steps[0]!.detail)).toMatchObject({
          disposition: 'exhausted',
          sent: 1,
          withheld: 1,
        });
      });
    });

    // ── atomicity and the interleavings ─────────────────────────────────────

    describe('atomicity and the lock-wait interleavings', () => {
      it('propagates a Send breaker read failure and enqueues no solicitation_send row', async () => {
        // The Send breaker FAILS CLOSED: `readSendBreaker` returns state or
        // THROWS, and the throw IS the halt signal (#622 §3.2B). A caller that
        // wraps it in try/catch and proceeds has broken the invariant — and
        // that caller passes every "breaker open" case, because the breaker is
        // not open. Only a THROWING read separates the two.
        spies.readSendBreaker.mockRejectedValue(new Error('breaker probe: connection reset'));
        const batch = await seedBatch(approvedBatchInput());
        await seedSendParent({ batch });
        await seedSolicitationPolicy(10);
        const { outreachId } = await seedOutreach({ batch });

        await expect(cycle()).rejects.toThrow('breaker probe: connection reset');

        expect(await readSendJobs()).toHaveLength(0);
        expect((await readOutreach(outreachId)).delivery_status).toBe('rendered');
        expect((await readBatch(batch.batchId)).sending_started_at).toBeNull();
      });

      it('raises a Sentry warning for a phase-level failure and still propagates it', async () => {
        // Round-2 finding. Before `alertPhaseFailure` the alerting was inverted:
        // an ITEM failure (blast radius one row) raised a Sentry issue, while a
        // PHASE failure — a scan, the breaker read, `groupByAccount` — raised
        // NOTHING. `createGuardedPoll` catches and never rethrows, and
        // `logger.error` has no Sentry hook, so the failure class that can wedge
        // the lane by suppressing every later phase (P5's backstop join
        // included) was the only one with no alert.
        //
        // ALERTING IS NOT CATCHING: the same case asserts the throw still
        // reaches the caller, because the breaker's throw IS the halt signal.
        const failure = new Error('breaker probe: phase-level sink');
        spies.readSendBreaker.mockRejectedValue(failure);

        await expect(cycle()).rejects.toThrow('breaker probe: phase-level sink');

        expect(sentrySpies.captureException).toHaveBeenCalledWith(
          failure,
          expect.objectContaining({
            level: 'warning',
            tags: { subsystem: 'solicitation-release', phase: 'release' },
          }),
        );
      });

      it('rolls back rendered-to-queued when enqueueSolicitationSend throws', async () => {
        // Round-1 finding 4: atomicity is proved by a FORCED FAILURE, not by
        // inspection. If the CAS and the enqueue ever split across
        // transactions, the row commits `queued` with no job — and P4 selects
        // `rendered` only, so nothing can ever move it again.
        spies.enqueueSolicitationSend.mockRejectedValue(new Error('outbox insert failed'));
        const batch = await seedBatch(approvedBatchInput());
        await seedSendParent({ batch });
        await seedSolicitationPolicy(10);
        const { outreachId } = await seedOutreach({ batch });

        // The cycle no longer PROPAGATES a per-item throw — it isolates it to
        // the BATCH and reports it (round-1 error isolation, narrowed from the
        // account to the batch in round 2; `release.ts` states both units). An
        // earlier version of this note said "the account", which was true only
        // between those two rounds. What this case is about is unchanged and is
        // asserted below: the transaction rolled back as one unit.
        const report = await cycle();

        expect(report.itemFailures).toBe(1);
        expect(report.released).toBe(0);
        const row = await readOutreach(outreachId);
        expect(row.delivery_status).toBe('rendered');
        expect(row.queued_at).toBeNull();
        expect(await readSendJobs()).toHaveLength(0);
        // The `sending_started_at` stamp is in the same transaction, so it
        // disappears with the CAS — proof the whole release is one unit.
        expect((await readBatch(batch.batchId)).sending_started_at).toBeNull();
      });

      it('rolls back unknown Outreach terminalization when lazy-child completion fails', async () => {
        // Round-2 finding 6: a success-path test cannot prove one transaction.
        // A split implementation passes the happy path, then commits `unknown`
        // and dies before terminalizing the child — leaving the child `running`
        // forever, which is the wedge this step exists to close, moved one row
        // over.
        spies.completeRun.mockRejectedValue(new Error('child completion failed'));
        const batch = await seedBatch(wedgedBatchInput());
        await seedSendParent({ batch });
        const sending = await seedOutreach({
          batch,
          deliveryStatus: 'sending',
          queuedAgo: '65 minutes',
          sendingAgo: '61 minutes',
        });
        const childRunId = await seedLazyChild(sending.askId, batch.businessId);
        await attachLazyChild(sending.outreachId, childRunId);

        // Isolated to the item rather than propagated (round-1 error-isolation
        // finding); the atomicity this case is about is asserted below.
        const report = await cycle();

        expect(report.itemFailures).toBe(1);
        expect(report.unknownTerminalized).toBe(0);
        expect((await readOutreach(sending.outreachId)).delivery_status).toBe('sending');
        expect((await readRun(childRunId)).status).toBe('running');
      });

      it('one failing item does not stop the phases after it', async () => {
        // Round-1 finding: every scan is `ORDER BY … ASC`, so without per-item
        // isolation one deterministically-failing row is re-selected as the
        // FIRST row of its phase on every subsequent tick and aborts every
        // phase after it — platform-wide, and permanently. That is issue #915's
        // wedge arriving through the door built to close it.
        //
        // The poisoned item is in phase 1; the work that must survive it is in
        // phase 4, on another location.
        spies.completeRun.mockRejectedValue(new Error('child completion failed'));
        const wedged = await seedBatch(wedgedBatchInput());
        await seedSendParent({ batch: wedged });
        const sending = await seedOutreach({
          batch: wedged,
          deliveryStatus: 'sending',
          queuedAgo: '65 minutes',
          sendingAgo: '61 minutes',
        });
        const childRunId = await seedLazyChild(sending.askId, wedged.businessId);
        await attachLazyChild(sending.outreachId, childRunId);

        const healthy = await seedBatch(approvedBatchInput({ onBusinessId: siblingBusinessId }));
        await seedSendParent({ batch: healthy });
        await seedSolicitationPolicy(10);
        const { outreachId } = await seedOutreach({ batch: healthy });

        const report = await cycle();

        expect(report.itemFailures).toBe(1);
        expect(report.unknownTerminalized).toBe(0);
        expect(report.released).toBe(1);
        expect((await readOutreach(outreachId)).delivery_status).toBe('queued');
        expect(await readSendJobs(outreachId)).toHaveLength(1);
        // Isolation is not swallowing: the failed item is left exactly as it
        // was, for the next tick and for the Sentry issue the catch raised.
        expect((await readOutreach(sending.outreachId)).delivery_status).toBe('sending');
        expect((await readRun(childRunId)).status).toBe('running');
      });

      it('one poisoned batch does not cost its sibling batches on the same account', async () => {
        // Round-2 finding. The release phase's `try` wrapped the whole ACCOUNT
        // block, per-batch loop included, while `applyJudgeSplit`,
        // `selectRenderedOutreach` and `releaseOutreachRow` are per-batch and
        // per-row. So one poisoned batch discarded the account's REMAINING
        // batches — deterministically, every tick, because the scan is
        // `approved_at ASC` and the poisoned batch is always selected first —
        // until they crossed the 72h send window and were cancelled. That is
        // #915's wedge narrowed to one account, not closed.
        //
        // Two batches, two locations (091 admits one active send per business),
        // and the POISONED one is the older approval, so P4 reaches it first.
        const poisoned = await seedBatch(approvedBatchInput({ approvedAgo: '2 hours' }));
        await seedSendParent({ batch: poisoned });
        const poisonedRow = await seedOutreach({ batch: poisoned });

        const sibling = await seedBatch(
          approvedBatchInput({ onBusinessId: siblingBusinessId, approvedAgo: '1 hour' }),
        );
        await seedSendParent({ batch: sibling });
        const siblingRow = await seedOutreach({ batch: sibling });
        await seedSolicitationPolicy(10);

        // ONCE: only the first release of the tick fails, which is the poisoned
        // batch's. The delegate re-armed in `beforeEach` serves the sibling.
        spies.enqueueSolicitationSend.mockRejectedValueOnce(new Error('outbox insert failed'));

        const report = await cycle();

        expect(report.itemFailures).toBe(1);
        expect(report.released).toBe(1);
        // The sibling released, which is the whole point.
        expect((await readOutreach(siblingRow.outreachId)).delivery_status).toBe('queued');
        expect(await readSendJobs(siblingRow.outreachId)).toHaveLength(1);
        // The poisoned batch is left exactly as it was — isolated, not swallowed
        // — and its unit rolled back whole (invariant #2).
        expect((await readOutreach(poisonedRow.outreachId)).delivery_status).toBe('rendered');
        expect(await readSendJobs(poisonedRow.outreachId)).toHaveLength(0);
        expect((await readBatch(poisoned.batchId)).sending_started_at).toBeNull();
      });

      it('does not clear approval when a concurrent Halt latch wins the batch lock', async () => {
        // Round-1 finding 7. A **Halt latch** does NOT clear `approved_at`, so
        // without the downgrade CAS's `halted_at IS NULL AND send_closed_at IS
        // NULL` arms a candidate that waited on the batch lock while the owner
        // halted would still match: it would erase the approval evidence of an
        // already-terminalized batch and append a false `approval_downgraded`
        // receipt after the fact.
        spies.isJudgeHealthy.mockResolvedValue(false);
        const batch = await seedBatch(approvedBatchInput());
        const parentRunId = await seedSendParent({ batch });
        await seedSolicitationPolicy(10);
        await seedOutreach({ batch });

        // The owner's halt, landing between the unlocked candidate selection and
        // the transaction that takes the batch lock.
        const halting = precedingExecutor(sql(), (tx) => tx`
          UPDATE solicitation_batches
          SET halted_at = NOW(), halt_reason = 'owner_halt', halted_by = ${userId()}::uuid
          WHERE id = ${batch.batchId}::uuid
            AND account_id = ${accountId()}::uuid
            AND business_id = ${batch.businessId}::uuid
            AND halted_at IS NULL
        `);

        const report = await cycle(halting);

        expect(report.downgraded).toBe(0);
        const after = await readBatch(batch.batchId);
        expect(after.halt_reason).toBe('owner_halt');
        expect(after.approved_at).not.toBeNull();
        expect(after.approval_method).toBe('owner');
        expect(after.approved_by_user_id).toBe(userId());
        expect(await readSteps(parentRunId, 'approval_downgraded')).toHaveLength(0);
      });

      it('does not downgrade when the approval window shuts while waiting for the batch lock', async () => {
        // Round-2 finding: the round-1 Judge fix was PARTIAL.
        // `approval_window_open` is computed by P4's SCAN and
        // `downgradeApproval`'s CAS did not re-assert it, so a downgrade taken
        // shortly before the window shut reproduced the original chain exactly —
        // `expired` **Batch state**, `approveBatch` refuses it (D2), P3 latches
        // `batch_expired` next tick, no notification on either step.
        //
        // `heldForJudge: 0` is the assertion that keeps this case honest: it
        // proves the SCAN saw the window open, so the CAS is what refused.
        spies.isJudgeHealthy.mockResolvedValue(false);
        const batch = await seedBatch(approvedBatchInput({ builtAgo: '6 days' }));
        const parentRunId = await seedSendParent({ batch });
        await seedSolicitationPolicy(10);
        const { outreachId } = await seedOutreach({ batch });

        const shutting = precedingExecutor(sql(), (tx) => tx`
          UPDATE solicitation_batches
          SET built_at = NOW() - INTERVAL '8 days'
          WHERE id = ${batch.batchId}::uuid
            AND account_id = ${accountId()}::uuid
            AND business_id = ${batch.businessId}::uuid
            AND built_at > NOW() - INTERVAL '8 days'
        `);

        const report = await cycle(shutting);

        expect(report.downgraded).toBe(0);
        expect(report.heldForJudge).toBe(0);
        const after = await readBatch(batch.batchId);
        expect(after.approved_at).not.toBeNull();
        expect(after.approval_method).toBe('owner');
        expect(after.approved_by_user_id).toBe(userId());
        expect(after.veto_deadline_at).not.toBeNull();
        expect(await readSteps(parentRunId, 'approval_downgraded')).toHaveLength(0);
        expect((await readOutreach(outreachId)).delivery_status).toBe('rendered');
      });

      it('does not release when the send window elapses while waiting for the batch lock', async () => {
        // Round-1 finding 8. P4 selects candidates BEFORE any lock is taken, so
        // a candidate that then waits on the batch lock — behind the
        // `send_window_elapsed` sweep or a long release — can become overdue.
        // Re-asserting the 72h window UNDER the lock is what stops a release
        // after the terminal deadline.
        //
        // `built_at` is anchored 100 hours back so the injected `approved_at`
        // still satisfies 091's `approved_at >= built_at` arm: the case is
        // about the send window, and a batch that was approved before it was
        // built would fail for a reason nothing here is about.
        const batch = await seedBatch(approvedBatchInput({ builtAgo: '100 hours' }));
        await seedSendParent({ batch });
        await seedSolicitationPolicy(10);
        const { outreachId } = await seedOutreach({ batch });

        const elapsing = precedingExecutor(sql(), (tx) => tx`
          UPDATE solicitation_batches
          SET approved_at = NOW() - INTERVAL '80 hours'
          WHERE id = ${batch.batchId}::uuid
            AND account_id = ${accountId()}::uuid
            AND business_id = ${batch.businessId}::uuid
            AND approved_at > NOW() - INTERVAL '80 hours'
        `);

        const report = await cycle(elapsing);

        expect(report.released).toBe(0);
        expect((await readOutreach(outreachId)).delivery_status).toBe('rendered');
        expect(await readSendJobs()).toHaveLength(0);
        expect((await readBatch(batch.batchId)).sending_started_at).toBeNull();
      });
    });

    // The default the poller runs with, asserted here so a change to the drip's
    // pacing lever cannot land without a reader noticing (every budget case
    // above passes its own value explicitly).
    it('RELEASE_PER_TICK_BUDGET is the platform-wide default the poller drips at', () => {
      expect(RELEASE_PER_TICK_BUDGET).toBe(2);
    });

    // #631 Task 1 (docs/superpowers/plans/2026-08-23-631-auto-approval-lane.md)
    // — the eval task. Bodies land in Tasks 3-8; this block only scaffolds the
    // eight promised release-time re-check titles for the Auto-approval lane,
    // verbatim from intake rev 2.
    //
    // #631 Task 6: relocated INSIDE describeWithDb (its original position was
    // a separate top-level `describe`, outside this closure — invisible while
    // every title here was `it.todo` since a todo never runs its body, but a
    // REAL test needs the outer beforeAll's `db` connection, which the outer
    // afterAll below tears down once this closure's OWN tests finish; a test
    // outside it ran against an already-`db.end()`'d connection and failed
    // with `CONNECTION_ENDED`). The 7 todos below are byte-for-byte
    // unchanged — only their nesting moved; Task 7 still owns their bodies.
    describe('auto_policy release re-check (#631)', () => {
      /** Arm the lane end-to-end — auto flag on, Autopilot tier, live policy
       *  row — so each case can break exactly ONE of the four re-check
       *  conditions and prove the recorded reason is that condition's. */
      async function armAutoLane(): Promise<void> {
        setEnv('SOLICITATION_AUTO_APPROVAL_ENABLED', 'true');
        await setSubscriptionTier('autopilot');
        await seedSolicitationPolicy(10);
      }

      /** An anchored `auto_policy` batch with an ELAPSED deadline — the P4
       *  candidate the re-check runs against — plus its Send batch parent and
       *  one rendered Outreach row. */
      async function seedAutoCandidate(
        overrides: BatchInput = {},
      ): Promise<{ batch: SeededBatch; parentRunId: string; outreachId: string }> {
        const batch = await seedBatch(
          approvedBatchInput({ approvalMethod: 'auto_policy', ...overrides }),
        );
        const parentRunId = await seedSendParent({ batch });
        const { outreachId } = await seedOutreach({ batch });
        return { batch, parentRunId, outreachId };
      }

      /** Every downgrade case asserts the same durable shape: all four
       *  approval columns NULLed together (the Requests panel must never see
       *  a batch it cannot act on), and the spine step carrying the EXACT
       *  reason — `toEqual`, so a stowaway key or a hard-coded constant both
       *  fail (R1 finding 5). */
      async function expectDowngraded(
        batchId: string,
        parentRunId: string,
        reason: string,
      ): Promise<void> {
        const after = await readBatch(batchId);
        expect(after.approved_at).toBeNull();
        expect(after.approval_method).toBeNull();
        expect(after.approved_by_user_id).toBeNull();
        expect(after.veto_deadline_at).toBeNull();
        expect(after.halted_at).toBeNull();
        const steps = await readSteps(parentRunId, 'approval_downgraded');
        expect(steps).toHaveLength(1);
        expect(jsonObject(steps[0]!.detail)).toEqual({ reason });
      }

      it(
        'downgrades an unreleased auto_policy batch to owner review when the auto flag is off at release',
        async () => {
          await armAutoLane();
          // ONLY the flag fails — tier, policy row and suspension all hold.
          // B15's boundary: the MASTER flag stays on, so the phase itself
          // runs and it is the re-check, not `flag_off`, that acts.
          setEnv('SOLICITATION_AUTO_APPROVAL_ENABLED', 'false');
          const { batch, parentRunId, outreachId } = await seedAutoCandidate();

          const report = await cycle();

          expect(report.autoDowngradedByReason).toEqual({ auto_approval_disabled: 1 });
          // The Judge counter is the OTHER lane's number — untouched.
          expect(report.downgraded).toBe(0);
          expect(report.released).toBe(0);
          expect(report.releasePhaseStoppedBy).toBeNull();
          await expectDowngraded(batch.batchId, parentRunId, 'auto_approval_disabled');
          expect((await readOutreach(outreachId)).delivery_status).toBe('rendered');
          expect(await readSendJobs(outreachId)).toHaveLength(0);
        },
      );

      it('downgrades an unreleased auto_policy batch when the account loses the Autopilot tier', async () => {
        await armAutoLane();
        // The entitlement lapse: a downgrade to the Copilot tier after the
        // batch auto-approved. `tierGrantsAutopilot` is the ONLY tier
        // predicate consulted (decision 6).
        await setSubscriptionTier('copilot');
        const { batch, parentRunId, outreachId } = await seedAutoCandidate();

        const report = await cycle();

        expect(report.autoDowngradedByReason).toEqual({ autopilot_entitlement_lost: 1 });
        expect(report.downgraded).toBe(0);
        expect(report.released).toBe(0);
        await expectDowngraded(batch.batchId, parentRunId, 'autopilot_entitlement_lost');
        expect((await readOutreach(outreachId)).delivery_status).toBe('rendered');
        expect(await readSendJobs(outreachId)).toHaveLength(0);
      });

      it('downgrades an unreleased auto_policy batch when the solicitation policy row is removed', async () => {
        // The owner's opt-in is gone: flag on, tier held — but NO
        // solicitation/sending account-default row exists any more.
        setEnv('SOLICITATION_AUTO_APPROVAL_ENABLED', 'true');
        await setSubscriptionTier('autopilot');
        const { batch, parentRunId, outreachId } = await seedAutoCandidate();

        const report = await cycle();

        expect(report.autoDowngradedByReason).toEqual({ policy_removed: 1 });
        expect(report.downgraded).toBe(0);
        expect(report.released).toBe(0);
        await expectDowngraded(batch.batchId, parentRunId, 'policy_removed');
        expect((await readOutreach(outreachId)).delivery_status).toBe('rendered');
        expect(await readSendJobs(outreachId)).toHaveLength(0);

        // Rev 2.1 (decision 6): the SAME failure landing AFTER a passing
        // arm-level check — between it and the row's release transaction —
        // releases NOTHING. Re-arm the lane, then delete the policy row at
        // the top of every transaction: the arm-level quick read runs
        // OUTSIDE any transaction and still sees the live row, so it passes;
        // `releaseOutreachRow`'s in-transaction guard re-reads the four
        // conditions under the batch + account locks, finds the opt-in gone,
        // and withholds the row unreleased — no CAS, no outbox row, no
        // un-approval. The durable downgrade belongs to the NEXT tick's
        // arm-level check.
        await seedSolicitationPolicy(10);
        const raced = await seedAutoCandidate({ onBusinessId: siblingBusinessId });
        const deletingExecutor = precedingExecutor(sql(), async (tx) => {
          await tx`
            DELETE FROM auto_approval_policies
            WHERE account_id = ${accountId()}::uuid
              AND persona = 'solicitation'
              AND action_class = 'sending'
              AND location_id IS NULL
          `;
        });

        const racedReport = await cycle(deletingExecutor);

        expect(racedReport.released).toBe(0);
        expect(racedReport.withheldByReason.auto_conditions).toBe(1);
        expect(racedReport.autoDowngradedByReason).toEqual({});
        const racedAfter = await readBatch(raced.batch.batchId);
        expect(racedAfter.approval_method).toBe('auto_policy');
        expect(racedAfter.approved_at).not.toBeNull();
        expect(racedAfter.veto_deadline_at).not.toBeNull();
        expect((await readOutreach(raced.outreachId)).delivery_status).toBe('rendered');
        expect(await readSendJobs(raced.outreachId)).toHaveLength(0);
        expect(await readSteps(raced.parentRunId, 'approval_downgraded')).toHaveLength(0);
      });

      it(
        'downgrades an unreleased auto_policy batch when a Governor suspension latches after approval',
        async () => {
          await armAutoLane();
          const { batch, parentRunId, outreachId } = await seedAutoCandidate();
          // The Governor's kill switch is per ACCOUNT (D19): ANY suspended
          // policy row on the account trips the re-check — and it outranks
          // the opt-in row's own health.
          await sql()`
            UPDATE auto_approval_policies
            SET suspended_at = NOW(), suspended_reason = 'governor_batch_rate'
            WHERE account_id = ${accountId()}::uuid
          `;

          const report = await cycle();

          expect(report.autoDowngradedByReason).toEqual({ policy_suspended: 1 });
          expect(report.downgraded).toBe(0);
          expect(report.released).toBe(0);
          await expectDowngraded(batch.batchId, parentRunId, 'policy_suspended');
          expect((await readOutreach(outreachId)).delivery_status).toBe('rendered');
          expect(await readSendJobs(outreachId)).toHaveLength(0);
        },
      );

      it(
        'a subscription lapse holds an auto_policy batch unchanged and never downgrades it',
        async () => {
          // B14: the lapse is the EXISTING recoverable `subscription`
          // withhold in the account arm. The auto re-check never consults
          // subscription status, so the approval evidence survives intact —
          // paying resumes the drip with no intervention, which un-approving
          // would have destroyed.
          await armAutoLane();
          await setSubscriptionStatus('past_due');
          const { batch, parentRunId, outreachId } = await seedAutoCandidate();
          const before = await readBatch(batch.batchId);

          const report = await cycle();

          expect(report.withheldByReason.subscription).toBeGreaterThanOrEqual(1);
          expect(report.autoDowngradedByReason).toEqual({});
          expect(report.downgraded).toBe(0);
          expect(report.released).toBe(0);
          expect(await readBatch(batch.batchId)).toEqual(before);
          expect(await readSteps(parentRunId, 'approval_downgraded')).toHaveLength(0);
          expect((await readOutreach(outreachId)).delivery_status).toBe('rendered');
          expect(await readSendJobs(outreachId)).toHaveLength(0);
        },
      );

      it('the auto downgrade records its exact reason and never judge_unavailable', async () => {
        // The STRONGEST arrangement: the Judge is down at the same moment an
        // auto condition fails. The re-check runs BEFORE the Judge split, so
        // the durable reason must be the auto condition's — filing it as
        // judge_unavailable would send the operator to the wrong dial.
        spies.isJudgeHealthy.mockResolvedValue(false);
        await armAutoLane();
        setEnv('SOLICITATION_AUTO_APPROVAL_ENABLED', 'false');
        const { batch, parentRunId } = await seedAutoCandidate();

        const report = await cycle();

        expect(report.autoDowngradedByReason).toEqual({ auto_approval_disabled: 1 });
        expect(report.downgraded).toBe(0);
        const steps = await readSteps(parentRunId, 'approval_downgraded');
        expect(steps).toHaveLength(1);
        const detail = jsonObject(steps[0]!.detail);
        expect(detail.reason).toBe('auto_approval_disabled');
        expect(detail.reason).not.toBe('judge_unavailable');
        // The ephemeral alert mirrors the durable record: the Auto-approval lane's own
        // Sentry title (never the Judge-outage issue) with the exact reason
        // as the tag.
        expect(sentrySpies.captureMessage).toHaveBeenCalledWith(
          'Solicitation batch approval downgraded: auto-approval conditions failed',
          expect.objectContaining({
            tags: expect.objectContaining({ reason: 'auto_approval_disabled' }),
          }),
        );
        await expectDowngraded(batch.batchId, parentRunId, 'auto_approval_disabled');
      });

      it('a mid-drip auto_policy batch is held when an auto condition fails, never unapproved', async () => {
        // Mid-drip (`sending_started_at` set) the batch cannot go back to the
        // owner at all — 091's send-ordering CHECK refuses it at the database
        // — so the split answers `held`: no writes, no spine step. The drip
        // resumes if the condition recovers, or P2 terminalizes the batch
        // honestly at the 72h window.
        await armAutoLane();
        setEnv('SOLICITATION_AUTO_APPROVAL_ENABLED', 'false');
        const batch = await seedBatch(wedgedBatchInput({ approvalMethod: 'auto_policy' }));
        const parentRunId = await seedSendParent({ batch });
        await seedOutreach({ batch, deliveryStatus: 'sent' });
        const { outreachId } = await seedOutreach({ batch });
        const before = await readBatch(batch.batchId);

        const report = await cycle();

        expect(report.autoDowngradedByReason).toEqual({});
        expect(report.downgraded).toBe(0);
        expect(report.released).toBe(0);
        // A hold writes nothing and takes no lock.
        expect(await readBatch(batch.batchId)).toEqual(before);
        expect(await readSteps(parentRunId)).toHaveLength(0);
        expect((await readOutreach(outreachId)).delivery_status).toBe('rendered');
        expect(await readSendJobs(outreachId)).toHaveLength(0);
      });

      // #631 Task 6 — the phase-wiring title. The other 7 todos above are
      // Task 7's (the release-time re-check); left untouched.
      it(
        'runReleaseCycle runs the Veto anchor phase before release and reports the anchored count',
        async () => {
          // An auto_policy batch, no deadline yet — the Veto anchor's candidate.
          const batch = await seedBatch(
            approvedBatchInput({ approvalMethod: 'auto_policy', vetoDeadlineAgo: undefined }),
          );
          const parentRunId = await seedSendParent({ batch });
          await seedOutreach({ batch });
          await sql()`
            INSERT INTO agent_run_steps (
              id, agent_run_id, step_index, step_key, attributed_agent, status, detail
            ) VALUES (
              ${randomUUID()}::uuid, ${parentRunId}::uuid, 1, 'batch_approved', 'solicitation',
              'completed',
              ${sql().json({
                approval_method: 'auto_policy',
                approved_count: 1,
                veto_window_minutes: 60,
              })}
            )
          `;
          await sql()`
            INSERT INTO notification_deliveries (
              id, business_id, account_id, entity_id, channel, recipient, template, sent_at
            ) VALUES (
              ${randomUUID()}::uuid, ${businessId}::uuid, ${accountId()}::uuid,
              ${batch.batchId}::uuid, 'email', 'owner@example.test',
              'solicitation_veto_notice', NOW()
            )
          `;

          const report = await cycle();
          expect(report.anchored).toBe(1);
          // The window (60 minutes, granted at "approval") has not elapsed
          // since the notice just sent — nothing released THIS tick, which
          // is what proves the anchor ran BEFORE the release phase read
          // `veto_deadline_at`: a batch anchored to a future deadline is
          // excluded from P4's `NOW() >= veto_deadline_at` candidate
          // predicate in the SAME cycle that set it.
          expect(report.released).toBe(0);

          const after = await readBatch(batch.batchId);
          expect(after.veto_deadline_at).not.toBeNull();
          expect(after.approval_method).toBe('auto_policy');

          // This file's shared afterEach does not clean
          // `notification_deliveries` (no other test in it writes that
          // table) — self-contained cleanup rather than widening the shared
          // hook for one test.
          await sql()`DELETE FROM notification_deliveries WHERE entity_id = ${batch.batchId}::uuid`;
        },
      );
    });
  },
);
