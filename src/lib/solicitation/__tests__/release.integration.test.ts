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
import { checksum, insertOutreach } from '@/lib/shared/__tests__/helpers/outreach-fixture';

// ─────────────────────────────────────────────────────────────────────────────
// THE `.fails` CONVENTION (#900 task 0, the eval task).
//
// `runReleaseCycle` throws `not implemented` today, so EVERY case below is
// registered with `it.fails` and carries a COMPLETE body. `.fails` runs the
// body, so the seeding, the fixtures and the imports are exercised from this
// commit onward — `it.todo` would have let a typo in a 40-line fixture hide
// until the implementation task tripped over it. Each later task deletes the
// `.fails` marker from exactly the titles it turns green (task 3 the release
// phase and the Judge split, task 4/5 the two expiry sweeps, task 6 the
// `unknown` sweep, task 7 the backstop and the flag scope).
//
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
// its own body. `enqueueSolicitationSend` does not exist yet (#900 task 1), so
// its delegate falls back to a loud throw naming the task rather than to
// `undefined`, which would fail with an unreadable "not a function".
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
  const real = (actual as Record<string, unknown>).enqueueSolicitationSend;
  spies.enqueueSolicitationSend.mockImplementation(
    typeof real === 'function'
      ? (real as (...args: unknown[]) => unknown)
      : () => {
          throw new Error('enqueueSolicitationSend not implemented (#900 task 1)');
        },
  );
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

import { STALLED_THRESHOLD_SEND_BATCH_DAYS } from '@/lib/agents/read';
import { resetServerConfigForTests } from '@/lib/config/server';
import { resetWorkerConfigForTests } from '@/lib/config/worker';
import { QUEUE_NAMES } from '@/lib/shared/queue-names';
import { countPlatformDispatchAttemptsToday } from '../send-caps';
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

let db: postgresType.Sql | undefined;
let featureDatabaseLock: LiveDbLock | undefined;
let tenant: TenantSeed | undefined;
const envBackup = new Map<string, string | undefined>();

function sql(): postgresType.Sql {
  if (!db) throw new Error('release integration database was not initialized');
  return db;
}

function accountId(): string {
  if (!tenant) throw new Error('release integration tenant was not seeded');
  return tenant.accountId;
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

async function seedUpload(onBusinessId: string): Promise<string> {
  const uploadId = randomUUID();
  await sql()`
    INSERT INTO contact_csv_uploads (
      id, account_id, business_id, filename, byte_size, content_sha256,
      raw_csv, status, report, attested_by_user_id, attested_at,
      attestation_version, completed_at
    ) VALUES (
      ${uploadId}::uuid, ${accountId()}::uuid, ${onBusinessId}::uuid,
      ${`release-${uploadId}.csv`}, 1, ${checksum(uploadId)},
      NULL, 'completed', ${sql().json({ accepted: 1 })},
      ${userId()}::uuid, NOW(), 'release-test', NOW()
    )
  `;
  return uploadId;
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
    | 'batch_expired';
}

interface SeededBatch {
  batchId: string;
  uploadId: string;
  businessId: string;
}

/**
 * One batch, carrying only the lifecycle columns the case is about.
 * `created_at` is anchored 40 days back so any `built_at` a case needs still
 * satisfies `solicitation_batches_built_after_created`.
 */
async function seedBatch(input: BatchInput = {}): Promise<SeededBatch> {
  const onBusinessId = input.onBusinessId ?? businessId;
  const uploadId = await seedUpload(onBusinessId);
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
      ${batchId}::uuid, ${accountId()}::uuid, ${onBusinessId}::uuid,
      ${uploadId}::uuid, NOW() - INTERVAL '40 days',
      NOW() - ${input.builtAgo ?? null}::interval,
      NOW() - ${input.approvedAgo ?? null}::interval,
      ${input.approvalMethod ?? null},
      ${input.approvalMethod === 'owner' ? userId() : null}::uuid,
      NOW() - ${input.vetoDeadlineAgo ?? null}::interval,
      NOW() - ${input.sendingStartedAgo ?? null}::interval,
      NOW() - ${input.sendClosedAgo ?? null}::interval,
      NOW() - ${input.haltedAgo ?? null}::interval,
      ${input.haltReason ?? null}, ${ownerHalt ? userId() : null}::uuid
    )
  `;
  return { batchId, uploadId, businessId: onBusinessId };
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
      ${runId}::uuid, ${accountId()}::uuid, ${input.batch.businessId}::uuid,
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
      ${askId}::uuid, ${accountId()}::uuid, ${batch.businessId}::uuid,
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
    accountId: accountId(),
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
    queuedAt: dispatched ? sql()`NOW() - ${input.queuedAgo ?? '2 seconds'}::interval` : null,
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
      const helpers = (await vi.importActual('@/lib/shared/job-outbox-helpers')) as Record<
        string,
        unknown
      >;
      const real = helpers.enqueueSolicitationSend;
      spies.enqueueSolicitationSend.mockImplementation(
        typeof real === 'function'
          ? (real as (...args: unknown[]) => unknown)
          : () => {
              throw new Error('enqueueSolicitationSend not implemented (#900 task 1)');
            },
      );

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

      const ownedBusinesses = [businessId, siblingBusinessId, thirdBusinessId];
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
      await sql()`DELETE FROM agent_runs WHERE account_id = ${accountId()}::uuid`;
      await sql()`DELETE FROM auto_approval_policies WHERE account_id = ${accountId()}::uuid`;
      await sql()`DELETE FROM account_audit_log WHERE account_id = ${accountId()}::uuid`;
    }, 60_000);

    afterAll(async () => {
      try {
        if (db) {
          for (const id of [businessId, siblingBusinessId, thirdBusinessId]) {
            await db`DELETE FROM businesses WHERE id = ${id}::uuid`;
          }
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
        await seedOutreach({ batch, deliveryStatus: 'queued', queuedAgo: '5 minutes' });
        const { outreachId } = await seedOutreach({ batch });

        const report = await cycle();

        expect(report.released).toBe(0);
        expect(report.withheldByReason.account_cap).toBeGreaterThanOrEqual(1);
        // Per-ACCOUNT, so the phase itself still ran for other accounts.
        expect(report.releasePhaseStoppedBy).toBeNull();
        expect((await readOutreach(outreachId)).delivery_status).toBe('rendered');
        expect(await readSendJobs(outreachId)).toHaveLength(0);
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
          await seedOutreach({ batch, deliveryStatus: 'queued', queuedAgo: '5 minutes' });
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
        await seedOutreach({ batch, deliveryStatus: 'queued', queuedAgo: '5 minutes' });
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
          const after = await readBatch(batch.batchId);
          expect(after.halted_at).not.toBeNull();
          expect(after.halt_reason).toBe('send_window_elapsed');
          // 091's halt-consistency CHECK requires halted_by IS NULL for exactly
          // the two SYSTEM reasons — the type says what the database enforces.
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

        await expect(cycle()).rejects.toThrow('outbox insert failed');

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

        await expect(cycle()).rejects.toThrow('child completion failed');

        expect((await readOutreach(sending.outreachId)).delivery_status).toBe('sending');
        expect((await readRun(childRunId)).status).toBe('running');
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
  },
);
