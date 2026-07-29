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
import { QUEUE_NAMES } from '@/lib/shared/queue-names';
import {
  runContentPurgeStage,
  type AccountOffboardingPurgeRow,
} from '../../../../worker/jobs/account-offboarding/purge-stages';
import { CONSENT_ATTESTATION_VERSION } from '../attestation';
import { acquireCsvIngestLock } from '../ingest';
import { acquireSolicitationBatchLock, buildSolicitationBatch } from '../batch-builder';

// #624 T8 — the GLOBAL lock order (advisory first, then row locks) proved
// against a live database, because that is the only place it exists.
//
// Batch construction and the offboarding content purge both take
// `solicitation_batch_<business>` and both then row-lock the same
// `solicitation_batches` rows. If either side takes its row lock first, the two
// form an ABBA cycle and Postgres kills one with 40P01. A single-transaction
// test cannot see that; two genuinely concurrent transactions can.
//
// Applies NO migration SQL (#573): `pnpm test:db:setup` provisions the schema
// and this suite asserts it. It holds the cross-process live-DB lock because it
// watches pg_stat_activity for a backend parked on an advisory lock — an
// unrelated live-DB writer in another vitest process would make that unreadable.

const testDatabaseUrl = resolveTestDatabaseUrl();
const businessId = randomUUID();

let db: postgresType.Sql | undefined;
let featureDatabaseLock: LiveDbLock | undefined;
let tenant: TenantSeed | undefined;

function sql(): postgresType.Sql {
  if (!db) throw new Error('batch-purge concurrency database was not initialized');
  return db;
}

function accountId(): string {
  if (!tenant) throw new Error('batch-purge concurrency tenant was not seeded');
  return tenant.accountId;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

interface SeededBatch {
  batchId: string;
  outboxId: string;
  uploadId: string;
  attempt: number;
}

async function seedBuildableBatch(): Promise<SeededBatch> {
  const uploadId = randomUUID();
  const batchId = randomUUID();
  const outboxId = randomUUID();
  const contactId = randomUUID();
  await sql()`
    INSERT INTO contact_csv_uploads (
      id, account_id, business_id, filename, byte_size, content_sha256,
      raw_csv, status, report, attested_by_user_id, attested_at,
      attestation_version, completed_at
    ) VALUES (
      ${uploadId}::uuid, ${accountId()}::uuid, ${businessId}::uuid,
      'batch-purge-concurrency.csv', 1,
      ${uploadId.replaceAll('-', '').padEnd(64, '0').slice(0, 64)},
      NULL, 'completed', ${sql().json({ accepted: 1 })},
      ${tenant!.userId}::uuid, NOW(), ${CONSENT_ATTESTATION_VERSION}, NOW()
    )
  `;
  await sql()`
    INSERT INTO solicitation_contacts (
      id, business_id, name, email, created_by_upload_id
    ) VALUES (
      ${contactId}::uuid, ${businessId}::uuid, 'Concurrency Candidate',
      ${`${contactId}@example.test`}, ${uploadId}::uuid
    )
  `;
  // Visit date seeded in SQL, never from a JS Date: postgres.js truncates
  // timestamptz microseconds on the way back out.
  await sql()`
    INSERT INTO solicitation_visits (
      id, contact_id, business_id, visit_date, upload_id
    ) VALUES (
      ${randomUUID()}::uuid, ${contactId}::uuid, ${businessId}::uuid,
      (NOW() - INTERVAL '3 days')::date, ${uploadId}::uuid
    )
  `;
  await sql()`
    INSERT INTO solicitation_batches (
      id, account_id, business_id, source_upload_id
    ) VALUES (
      ${batchId}::uuid, ${accountId()}::uuid, ${businessId}::uuid, ${uploadId}::uuid
    )
  `;
  await sql()`
    INSERT INTO job_outbox (
      id, topic, aggregate_type, aggregate_id, payload,
      status, attempts, dispatched_at
    ) VALUES (
      ${outboxId}::uuid, ${QUEUE_NAMES.BUILD_SOLICITATION_BATCH},
      'solicitation_batch', ${batchId}::uuid,
      ${sql().json({ batch_id: batchId, business_id: businessId })},
      'dispatched', 1, NOW()
    )
  `;
  return { batchId, outboxId, uploadId, attempt: 1 };
}

function build(batch: SeededBatch) {
  return buildSolicitationBatch(sql(), {
    batchId: batch.batchId,
    businessId,
    outboxId: batch.outboxId,
    attempt: batch.attempt,
    correlationId: 'batch-purge-concurrency',
  });
}

/**
 * Resolves once some backend is PARKED on the advisory-lock statement. That is
 * the contention this suite exists to observe: under the correct order the
 * builder waits there before touching a row, under the inverted order it waits
 * there while already holding the batch row lock — and only the second is a
 * deadlock.
 */
async function waitForAdvisoryLockWaiter(timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const [waiting] = await sql()<{ waiters: number }[]>`
      SELECT COUNT(*)::int AS waiters
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND wait_event_type = 'Lock'
        AND query ILIKE '%pg_advisory_xact_lock%'
    `;
    if ((waiting?.waiters ?? 0) > 0) return;
    if (Date.now() > deadline) {
      throw new Error('no backend ever parked on the solicitation_batch advisory lock');
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function isDeadlock(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && (error as { code?: unknown }).code === '40P01';
}

async function countForAccount(table: 'solicitation_batches' | 'solicitation_outreach'): Promise<number> {
  const [row] = table === 'solicitation_batches'
    ? await sql()<{ count: number }[]>`
        SELECT COUNT(*)::int AS count FROM solicitation_batches
        WHERE account_id = ${accountId()}::uuid
      `
    : await sql()<{ count: number }[]>`
        SELECT COUNT(*)::int AS count FROM solicitation_outreach
        WHERE account_id = ${accountId()}::uuid
      `;
  return row?.count ?? 0;
}

describeWithDb(
  'batch build versus offboarding purge against live local Postgres',
  { enabled: Boolean(testDatabaseUrl), timeout: 90_000 },
  () => {
    beforeAll(async () => {
      const databaseUrl = assertLocalTestDatabaseUrl(testDatabaseUrl);
      featureDatabaseLock = await acquireLiveDbLock(databaseUrl);
      // Six connections: the parked purge, the builder's two transactions, the
      // pg_stat_activity probe, and the fixture/assertion queries.
      db = postgres(databaseUrl, { max: 6, prepare: false });
      await assertSchemaReady(db, [
        MIGRATION_088_SOLICITATION_BATCH_EXECUTOR,
        MIGRATION_091_SEND_MODE_SPINE_LIFECYCLE,
      ]);
      tenant = await seedTenantAccount(db, {
        userName: 'Batch Purge Concurrency Owner',
        accountDisplayName: 'Batch Purge Concurrency Account',
      });
      await db`
        INSERT INTO businesses (
          id, name, owner_name, owner_email, account_id,
          subscription_status, category
        ) VALUES (
          ${businessId}::uuid, 'Batch Purge Concurrency Business', 'Concurrency Owner',
          ${tenant.ownerEmail}, ${tenant.accountId}::uuid, 'active', 'automotive'
        )
      `;
    }, LIVE_DB_LOCK_HOOK_TIMEOUT_MS);

    afterEach(async () => {
      delete process.env.SOLICITATION_WATCH_ENABLED;
      await sql()`DELETE FROM job_outbox WHERE aggregate_type = 'solicitation_batch'`;
      await sql()`
        DELETE FROM agent_runs WHERE account_id = ${accountId()}::uuid
      `;
      await sql()`DELETE FROM contact_csv_uploads WHERE account_id = ${accountId()}::uuid`;
      await sql()`DELETE FROM solicitation_contacts WHERE business_id = ${businessId}::uuid`;
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

    it('a concurrent batch build and offboarding purge contend on the advisory lock without deadlocking', async () => {
      process.env.SOLICITATION_WATCH_ENABLED = 'true';

      // ── Part 1: the interleaving that used to deadlock ──────────────────
      // A purge-shaped transaction holds both advisory keys in the purge's own
      // order (via the same helpers — one derivation of each key) and parks
      // BEFORE its row locks. The builder then runs for real. Under the global
      // order it parks on the advisory lock and takes no row lock at all;
      // inverted, it parks there holding the batch row the purge is about to
      // ask for, which is the ABBA cycle.
      const seeded = await seedBuildableBatch();
      const locksHeld = deferred();
      const purgeMayProceed = deferred();
      const events: string[] = [];

      const purge = sql().begin(async (tx) => {
        await acquireCsvIngestLock(tx, businessId);
        await acquireSolicitationBatchLock(tx, businessId);
        locksHeld.resolve();
        await purgeMayProceed.promise;
        // The purge's second half: row locks, under the advisory lock.
        await tx`
          SELECT id FROM solicitation_batches
          WHERE business_id = ${businessId}::uuid
          FOR UPDATE
        `;
        await tx`
          DELETE FROM contact_csv_uploads WHERE account_id = ${accountId()}::uuid
        `;
      }).then(() => { events.push('purge'); });

      await locksHeld.promise;
      const building = build(seeded).then((result) => {
        events.push('build');
        return result;
      });

      // The builder must be blocked, not merely slow.
      await waitForAdvisoryLockWaiter();
      purgeMayProceed.resolve();

      const [, buildResult] = await Promise.all([purge, building]);

      // Serialized, not interleaved: the builder resumed only after the purge
      // committed and released the key.
      expect(events).toEqual(['purge', 'build']);
      // Whichever way the cascade landed, the builder never corrupted state and
      // never died of a deadlock.
      expect(['missing', 'built']).toContain(buildResult.status);
      expect(await countForAccount('solicitation_batches')).toBe(0);
      expect(await countForAccount('solicitation_outreach')).toBe(0);

      // ── Part 2: the real purge stage, unchoreographed ───────────────────
      // Same two writers, no barrier — whoever wins the key runs first.
      const raced = await seedBuildableBatch();
      const purgeRow = { account_id: accountId() } as AccountOffboardingPurgeRow;
      const settled = await Promise.allSettled([
        runContentPurgeStage(sql(), purgeRow),
        build(raced),
      ]);

      for (const outcome of settled) {
        if (outcome.status === 'rejected') {
          expect(isDeadlock(outcome.reason)).toBe(false);
          throw outcome.reason;
        }
      }
      expect(await countForAccount('solicitation_batches')).toBe(0);
      expect(await countForAccount('solicitation_outreach')).toBe(0);
    });
  },
);
