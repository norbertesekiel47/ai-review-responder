// Live-Postgres suite for the OutboxPoller watchdog's terminalizer (#736).
//
// The unit suite pins the query's SHAPE against a mock sql; only a real
// database proves the value-level contract the fix is about: a stale
// dispatched row that already carries a per-job `last_error` (a bounded error
// class written by a failed-hook via recordOutboxTransientError, or the
// poller's own dispatch-failure text) KEEPS it when the watchdog terminalizes
// the row, and the generic reclaim text is written only when nothing was
// recorded. The pre-#736 unconditional overwrite is what let #719 hide for
// three months — 93 failed rows, every one reading as a routine reclaim.
//
// Drives `runOutboxWatchdogRecovery(db, staleSecs, logger)` — extracted for
// exactly this purpose — with this suite's own client, so the claim/dispatch
// phases never run (no Redis, no contaminating-row claims). The queue registry
// is mocked because importing OutboxPoller pulls in worker/queues.ts, which
// constructs BullMQ Queues (Redis connections) at module scope.
//
// Applies NO migration SQL: `pnpm test:db:setup` provisions the schema and
// this file asserts it with `assertSchemaReady` (#573). It DOES hold the
// cross-process live-DB lock, following ArchivalPoller.integration.test.ts —
// the watchdog is a platform-wide sweep over stale dispatched rows, so a
// live-DB writer in another vitest process could have its in-flight fixtures
// terminalized mid-test. Assertions scope to seeded row ids only.
//
// #1378 widened coverage from the terminalizer's `dispatched` branch to its
// `dispatching` branch on EVERY topic. That branch was written topic-scoped to
// `agent_turn` (#1291), which left a row that is `dispatching` AND at
// max_attempts AND on any other topic matching no watchdog arm and no claim —
// a permanent orphan. The cases below are seeded on PROBE_TOPIC precisely
// because it is not `agent_turn`: re-scoping the predicate turns case 1 red.
// The 2-minute window is the same one arm 3 uses; the fresh-row case pins the
// guard that keeps a row the current cycle is still dispatching out of reach.

import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import type { Sql } from 'postgres';
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
  type SchemaRequirement,
} from '@/lib/shared/__tests__/helpers/schema-ready';
import type { WorkerLogger } from '@/lib/shared/logger';

vi.mock('../../../queues', () => ({ topicToQueue: {} }));

// Imported AFTER the queues mock is registered (vi.mock hoists above imports,
// so a static import is safe — noted for the reader, not the runtime).
import { runOutboxWatchdogRecovery } from '../OutboxPoller';

const testDatabaseUrl = resolveTestDatabaseUrl();

/** Default OUTBOX_WATCHDOG_STALE_MS is 15 minutes; the seam takes seconds. */
const WATCHDOG_STALE_SECS = 900;

/**
 * Interpolated as a bind parameter, never a SQL literal — a topic the queue
 * registry does not know, so nothing else in the system can match these rows.
 * The watchdog itself is deliberately topic-blind.
 */
const PROBE_TOPIC = 'outbox_watchdog_integration_probe';

const GENERIC_RECLAIM_TEXT = 'Stale dispatched entry exceeded max_attempts';
/** The terminalizer's CASE picks this text for a `dispatching` row, not the
 * `dispatched` one above — asserting it is what proves the branch taken. */
const DISPATCHING_RECLAIM_TEXT = 'Stale dispatching entry exceeded max_attempts';

/** Hard-coded `INTERVAL '2 minutes'` in both dispatching arms, not env-tunable. */
const DISPATCHING_STALE_SECS = 120;

const OUTBOX_WATCHDOG_SCHEMA: SchemaRequirement = {
  migration: '001_initial_schema + 004_outbox_dispatching',
  tables: ['job_outbox'],
  columns: [
    'job_outbox.last_error',
    'job_outbox.dispatched_at',
    'job_outbox.completed_at',
    'job_outbox.max_attempts',
  ],
};

const loggerStub: WorkerLogger = {
  log: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
} as unknown as WorkerLogger;

let featureDatabaseLock: LiveDbLock | undefined;
let suiteSql: Sql | undefined;

function db(): Sql {
  if (!suiteSql) throw new Error('outbox watchdog integration database was not initialized');
  return suiteSql;
}

// ── Fixture bookkeeping ──────────────────────────────────────────────

const seededRowIds: string[] = [];

interface SeedOptions {
  status?: 'dispatched' | 'dispatching';
  attempts: number;
  /** Age of dispatched_at, written as a SQL interval off NOW() — never a JS
   * Date: postgres.js truncates timestamptz microseconds, and the stale window
   * boundary is exactly what these rows sit on either side of. `null` seeds a
   * NULL dispatched_at. `claimPendingBatch` always stamps NOW(), so no known
   * production path reaches dispatching-with-NULL; both dispatching arms carry
   * `dispatched_at IS NULL OR …` anyway, and the terminal arm inherits that
   * disjunct verbatim from arm 3. This case pins the inherited behavior so a
   * later simplification of either arm cannot silently drop it from one only. */
  dispatchedSecsAgo: number | null;
  lastError?: string | null;
}

async function seedRow(options: SeedOptions): Promise<string> {
  const id = randomUUID();
  await db()`
    INSERT INTO job_outbox (
      id, topic, aggregate_type, aggregate_id, payload, status,
      attempts, max_attempts, dispatched_at, last_error
    ) VALUES (
      ${id}::uuid, ${PROBE_TOPIC}, 'business', ${randomUUID()}::uuid,
      ${db().json({ probe: true })}, ${options.status ?? 'dispatched'},
      ${options.attempts}, 5,
      CASE WHEN ${options.dispatchedSecsAgo}::int IS NULL THEN NULL
           ELSE NOW() - make_interval(secs => ${options.dispatchedSecsAgo}::int) END,
      ${options.lastError ?? null}
    )
  `;
  seededRowIds.push(id);
  return id;
}

interface RowState {
  status: string;
  last_error: string | null;
  completed_at: Date | null;
  dispatched_at: Date | null;
}

async function rowState(id: string): Promise<RowState> {
  const [row] = await db()<RowState[]>`
    SELECT status, last_error, completed_at, dispatched_at
    FROM job_outbox WHERE id = ${id}::uuid
  `;
  if (!row) throw new Error(`seeded outbox row ${id} disappeared`);
  return row;
}

function runWatchdog(): Promise<void> {
  return runOutboxWatchdogRecovery(db(), WATCHDOG_STALE_SECS, loggerStub);
}

describeWithDb(
  'OutboxPoller watchdog terminalizer against live local Postgres',
  { enabled: Boolean(testDatabaseUrl), timeout: 120_000 },
  () => {
    beforeAll(async () => {
      const databaseUrl = assertLocalTestDatabaseUrl(testDatabaseUrl);
      featureDatabaseLock = await acquireLiveDbLock(databaseUrl);
      suiteSql = postgres(databaseUrl, {
        max: 4,
        prepare: false,
        onnotice: () => {},
      });
      await assertSchemaReady(db(), [OUTBOX_WATCHDOG_SCHEMA]);
    }, LIVE_DB_LOCK_HOOK_TIMEOUT_MS);

    afterEach(async () => {
      if (seededRowIds.length > 0) {
        await db()`DELETE FROM job_outbox WHERE id IN ${db()(seededRowIds)}`;
        seededRowIds.length = 0;
      }
    }, 60_000);

    afterAll(async () => {
      await suiteSql?.end({ timeout: 5 });
      suiteSql = undefined;
      await featureDatabaseLock?.release();
      featureDatabaseLock = undefined;
    }, 120_000);

    // ── #736 acceptance: preserve a per-job last_error ────────────────

    it('keeps a per-job last_error when terminalizing a stale exhausted row', async () => {
      const perJobError = 'csv_ingest_exhausted:PostgresError';
      const id = await seedRow({
        attempts: 5,
        dispatchedSecsAgo: WATCHDOG_STALE_SECS + 300,
        lastError: perJobError,
      });

      await runWatchdog();

      const row = await rowState(id);
      expect(row.status).toBe('failed');
      expect(row.last_error).toBe(perJobError);
      expect(row.completed_at).not.toBeNull();
    });

    it('writes the generic reclaim text only when no error was recorded', async () => {
      const nullError = await seedRow({
        attempts: 5,
        dispatchedSecsAgo: WATCHDOG_STALE_SECS + 300,
        lastError: null,
      });
      // Empty string is "nothing recorded" too — NULLIF folds it to the
      // fallback rather than preserving a blank that explains nothing.
      const emptyError = await seedRow({
        attempts: 5,
        dispatchedSecsAgo: WATCHDOG_STALE_SECS + 300,
        lastError: '',
      });

      await runWatchdog();

      expect((await rowState(nullError)).last_error).toBe(GENERIC_RECLAIM_TEXT);
      expect((await rowState(emptyError)).last_error).toBe(GENERIC_RECLAIM_TEXT);
    });

    it('re-pends a retryable stale row without touching its last_error', async () => {
      // The generate-asks retryable-exhaustion path deliberately leaves the
      // row dispatched carrying its own last_error, with the watchdog as the
      // out-of-band re-driver (#736 acceptance: that error must survive).
      const retryableError = 'generate_solicitation_asks_exhausted_retryable:TimeoutError';
      const id = await seedRow({
        attempts: 1,
        dispatchedSecsAgo: WATCHDOG_STALE_SECS + 300,
        lastError: retryableError,
      });

      await runWatchdog();

      const row = await rowState(id);
      expect(row.status).toBe('pending');
      expect(row.last_error).toBe(retryableError);
      expect(row.completed_at).toBeNull();
    });

    it('leaves a fresh dispatched row alone', async () => {
      const id = await seedRow({
        attempts: 5,
        dispatchedSecsAgo: 60,
        lastError: 'still_running_do_not_touch',
      });

      await runWatchdog();

      const row = await rowState(id);
      expect(row.status).toBe('dispatched');
      expect(row.last_error).toBe('still_running_do_not_touch');
      expect(row.completed_at).toBeNull();
    });

    // ── #1378 acceptance: the terminalizer's dispatching branch is topic-blind ──

    it('terminalizes a stale dispatching row at max_attempts on a non-agent_turn topic', async () => {
      // The orphan of record. Before #1378 this row matched no arm — arm 1
      // needs 'dispatched', arm 2's dispatching disjunct was scoped to
      // agent_turn, arm 3 needs attempts remaining — and claimPendingBatch
      // reads only 'pending', so nothing could ever own it again.
      const id = await seedRow({
        status: 'dispatching',
        attempts: 5,
        dispatchedSecsAgo: DISPATCHING_STALE_SECS + 60,
      });

      await runWatchdog();

      const row = await rowState(id);
      expect(row.status).toBe('failed');
      expect(row.completed_at).not.toBeNull();
    });

    it('terminalizes a stale dispatching row whose dispatched_at is NULL', async () => {
      const id = await seedRow({
        status: 'dispatching',
        attempts: 5,
        dispatchedSecsAgo: null,
      });

      await runWatchdog();

      const row = await rowState(id);
      expect(row.status).toBe('failed');
      expect(row.completed_at).not.toBeNull();
    });

    it('writes the dispatching reclaim text when a terminalized dispatching row recorded no error', async () => {
      // Distinguishes the CASE's dispatching branch from its dispatched one:
      // a wrong branch still yields status='failed', so only the text catches it.
      const nullError = await seedRow({
        status: 'dispatching',
        attempts: 5,
        dispatchedSecsAgo: DISPATCHING_STALE_SECS + 60,
        lastError: null,
      });
      const emptyError = await seedRow({
        status: 'dispatching',
        attempts: 5,
        dispatchedSecsAgo: DISPATCHING_STALE_SECS + 60,
        lastError: '',
      });

      await runWatchdog();

      expect((await rowState(nullError)).last_error).toBe(DISPATCHING_RECLAIM_TEXT);
      expect((await rowState(emptyError)).last_error).toBe(DISPATCHING_RECLAIM_TEXT);
      expect(DISPATCHING_RECLAIM_TEXT).not.toBe(GENERIC_RECLAIM_TEXT);
    });

    it('keeps a per-job last_error when terminalizing a stale dispatching row', async () => {
      // #736's preservation contract holds on the branch #1378 widened, not
      // only on the dispatched branch the original acceptance covered.
      const perJobError = 'publish_response_exhausted:ZernioError';
      const id = await seedRow({
        status: 'dispatching',
        attempts: 5,
        dispatchedSecsAgo: DISPATCHING_STALE_SECS + 60,
        lastError: perJobError,
      });

      await runWatchdog();

      const row = await rowState(id);
      expect(row.status).toBe('failed');
      expect(row.last_error).toBe(perJobError);
    });

    it('re-pends a stale dispatching row that still has attempts left', async () => {
      // Arm 3, unchanged by #1378 and pinned here so the widened arm 2 cannot
      // start swallowing rows that are still retryable.
      const id = await seedRow({
        status: 'dispatching',
        attempts: 1,
        dispatchedSecsAgo: DISPATCHING_STALE_SECS + 60,
      });

      await runWatchdog();

      const row = await rowState(id);
      expect(row.status).toBe('pending');
      expect(row.dispatched_at).toBeNull();
      expect(row.completed_at).toBeNull();
    });

    it('leaves a freshly claimed dispatching row at max_attempts alone', async () => {
      // The false-positive guard. A row on its final attempt is 'dispatching'
      // with dispatched_at = NOW() for the whole window between the claim and
      // markDispatched; terminalizing inside that window would fail live work.
      const id = await seedRow({
        status: 'dispatching',
        attempts: 5,
        dispatchedSecsAgo: 30,
      });

      await runWatchdog();

      const row = await rowState(id);
      expect(row.status).toBe('dispatching');
      expect(row.completed_at).toBeNull();
      expect(row.last_error).toBeNull();
    });
  },
);
