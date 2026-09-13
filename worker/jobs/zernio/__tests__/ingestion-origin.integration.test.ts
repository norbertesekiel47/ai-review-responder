// worker/jobs/zernio/__tests__/ingestion-origin.integration.test.ts
//
// Live-Postgres proof for the Run C ingestion-origin marker on the two review
// INSERT sites that interact through ON CONFLICT: processReview (live lane) and
// the answered-import insert inside reconcileExternallyAnsweredReview. The
// mocked suites pin the branching; only a real database proves what the
// `ON CONFLICT … DO UPDATE … RETURNING id` arm actually returns under a real
// same-identity race, and that the marker commits or rolls back with the row.
//
// Schema is ASSERTED, never applied; no DDL runs here (`ci:live-db-suites`).
// Exactly two connections: `db` (seed, assertions, and the live winner) and
// `racer` (the answered import). The race barrier is Postgres's own lock
// graph (`pg_blocking_pids`), not a sleep.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import postgres from 'postgres';
import type postgresType from 'postgres';
import { describeWithDb } from '@/__tests__/helpers/describe-with-db';
import { abortingExecutor } from '@/lib/shared/__tests__/helpers/abort-injection';
import {
  cleanupTenantAccount,
  seedTenantAccount,
  type TenantSeed,
} from '@/lib/shared/__tests__/live-db-tenant';
import {
  assertSchemaReady,
  MIGRATION_071_RUN_SPINE,
  MIGRATION_088_SOLICITATION_BATCH_EXECUTOR,
} from '@/lib/shared/__tests__/helpers/schema-ready';
import { processReview } from '@/lib/reviews/process-review';
import { buildZernioMonitoredReview } from '@/lib/reviews/zernio-normalize';
import type { ZernioReview } from '@/lib/zernio/types';
import type { WorkerLogger } from '@/lib/shared/logger';
import { reconcileExternallyAnsweredReview } from '../zernio-ingest-shared';

const testDatabaseUrl = process.env.TEST_DATABASE_POOL_URL;

let db: postgresType.Sql | undefined;
let racer: postgresType.Sql | undefined;
let tenant: TenantSeed | undefined;
const businessId = randomUUID();
// Provider identifiers, deliberately NOT uuids and never equal to the billing
// account: a marker filed under the Zernio account would fail loudly.
const zernioAccountId = `zacct-origin-${randomUUID()}`;
const zernioLocationId = `zloc-origin-${randomUUID()}`;

const logger: WorkerLogger = { log: () => {}, warn: () => {}, error: () => {} };

function sql(): postgresType.Sql {
  if (!db) throw new Error('ingestion-origin integration database was not initialized');
  return db;
}

function racerSql(): postgresType.Sql {
  if (!racer) throw new Error('ingestion-origin racer connection was not initialized');
  return racer;
}

function tenantAccountId(): string {
  if (!tenant) throw new Error('ingestion-origin tenant was not seeded');
  return tenant.accountId;
}

function mkZernioReview(label: string): ZernioReview {
  const id = `origin-${label}-${randomUUID()}`;
  return {
    id,
    name: `accounts/${zernioAccountId}/locations/${zernioLocationId}/reviews/${id}`,
    reviewer: { displayName: 'Origin Fixture Reviewer', profilePhotoUrl: '', isAnonymous: false },
    rating: 4,
    starRating: 'FOUR',
    comment: 'Friendly staff and quick service.',
    createTime: '2026-07-01T12:00:00Z',
    updateTime: '2026-07-01T12:00:00Z',
    reviewReply: { comment: 'Thank you for visiting us.', updateTime: '2026-07-02T12:00:00Z' },
  };
}

function providerReviewName(review: ZernioReview): string {
  return buildZernioMonitoredReview(review, zernioAccountId, zernioLocationId).identity.providerReviewName;
}

async function reviewIds(review: ZernioReview): Promise<string[]> {
  const rows = await sql()<{ id: string }[]>`
    SELECT id FROM reviews WHERE provider_review_name = ${providerReviewName(review)}
  `;
  return rows.map((r) => r.id);
}

/** Every persisted review_ingested marker for one review, read from JSONB. */
async function ingestionMarkers(reviewId: string) {
  return sql()<{ origin: string | null; account_id: string; run_status: string }[]>`
    SELECT s.detail->>'ingestion_origin' AS origin, r.account_id, r.status AS run_status
    FROM agent_run_steps s
    JOIN agent_runs r ON r.id = s.agent_run_id
    WHERE r.kind = 'review_handler'
      AND r.subject_type = 'review'
      AND r.subject_id = ${reviewId}
      AND s.step_key = 'review_ingested'
  `;
}

async function postedResponseCount(reviewId: string): Promise<number> {
  const [row] = await sql()<{ n: number }[]>`
    SELECT COUNT(*)::int AS n FROM responses
    WHERE review_id = ${reviewId}::uuid AND status = 'posted'
  `;
  return row?.n ?? 0;
}

async function reviewRunCount(): Promise<number> {
  const [row] = await sql()<{ n: number }[]>`
    SELECT COUNT(*)::int AS n FROM agent_runs
    WHERE account_id = ${tenantAccountId()}::uuid AND kind = 'review_handler'
  `;
  return row?.n ?? 0;
}

/** A REAL Postgres error, so the transaction is genuinely aborted. */
const divisionByZero = (tx: postgresType.TransactionSql): Promise<unknown> =>
  tx`SELECT 1 / 0 AS poison`;

/**
 * Wraps `base` so `.begin(cb)` runs `cb`, then `beforeCommit` on the same
 * still-open transaction. Only the `begin(cb)` form processReview uses.
 */
function executorHoldingCommit(
  base: postgresType.Sql,
  beforeCommit: (tx: postgresType.TransactionSql) => Promise<void>,
): postgresType.Sql {
  return new Proxy(base, {
    get(target, prop) {
      if (prop !== 'begin') {
        const value: unknown = Reflect.get(target, prop);
        return typeof value === 'function' ? value.bind(target) : value;
      }
      return (callback: (tx: postgresType.TransactionSql) => Promise<unknown>) =>
        target.begin(async (tx) => {
          const result = await callback(tx);
          await beforeCommit(tx);
          return result;
        });
    },
  });
}

/**
 * Returns once `blockedPid` is waiting on a lock held by `tx`'s backend.
 * `pg_blocking_pids` reads the live lock graph (unlike pg_stat_activity, it is
 * not snapshotted per transaction), so polling it from inside the holder's own
 * transaction needs no third connection and no sleep.
 */
async function waitUntilBlockedBy(
  tx: postgresType.TransactionSql,
  blockedPid: number,
  racerSettled: () => boolean,
): Promise<void> {
  const [holder] = await tx<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
  const deadline = Date.now() + 10_000;
  for (;;) {
    const [row] = await tx<{ blocked: boolean }[]>`
      SELECT ${holder!.pid}::int = ANY(pg_blocking_pids(${blockedPid}::int)) AS blocked
    `;
    if (row?.blocked) return;
    if (racerSettled()) {
      throw new Error('the racing import finished without ever waiting on the live insert');
    }
    if (Date.now() > deadline) {
      throw new Error('the racing import never blocked on the uncommitted live insert');
    }
  }
}

describeWithDb('review ingestion_origin marker against live Postgres', { timeout: 30_000 }, () => {
  beforeAll(async () => {
    db = postgres(testDatabaseUrl!, { max: 1, prepare: false });
    racer = postgres(testDatabaseUrl!, { max: 1, prepare: false });
    // 071 is the run spine read here; 088 adds agent_runs.parent_run_id, which
    // startOrGetActiveRun binds (same pairing as import-review.integration.test.ts).
    await assertSchemaReady(db, [
      MIGRATION_071_RUN_SPINE,
      MIGRATION_088_SOLICITATION_BATCH_EXECUTOR,
    ]);
    tenant = await seedTenantAccount(db, {
      userName: 'Ingestion Origin Owner',
      accountDisplayName: 'Ingestion Origin Account',
    });

    await sql()`
      INSERT INTO businesses (
        id, name, owner_name, owner_email, account_id
      ) VALUES (
        ${businessId}::uuid, 'Ingestion Origin Location', 'Ingestion Origin Owner',
        ${tenant.ownerEmail}, ${tenant.accountId}::uuid
      )
    `;
  });

  afterAll(async () => {
    if (db && tenant) {
      await sql()`DELETE FROM analytics_events WHERE account_id = ${tenant.accountId}::uuid`;
      await sql()`DELETE FROM job_outbox WHERE aggregate_id::text IN (
        SELECT id::text FROM reviews WHERE business_id = ${businessId}::uuid
      )`;
      await sql()`DELETE FROM agent_run_steps WHERE agent_run_id IN (
        SELECT id FROM agent_runs WHERE account_id = ${tenant.accountId}::uuid
      )`;
      await sql()`DELETE FROM agent_runs WHERE account_id = ${tenant.accountId}::uuid`;
      await sql()`DELETE FROM responses WHERE business_id = ${businessId}::uuid`;
      await sql()`DELETE FROM reviews WHERE business_id = ${businessId}::uuid`;
      await sql()`DELETE FROM businesses WHERE id = ${businessId}::uuid`;
      await cleanupTenantAccount(sql(), tenant);
    }
    await racer?.end({ timeout: 5 });
    await db?.end({ timeout: 5 });
  });

  it('an answered import that genuinely inserts records imported under the billing account; a duplicate adds nothing', async () => {
    const review = mkZernioReview('winner');

    await reconcileExternallyAnsweredReview(
      sql(), review, businessId, zernioAccountId, zernioLocationId, logger, { consentedImport: true },
    );

    const [reviewId] = await reviewIds(review);
    expect(reviewId).toBeDefined();
    expect(await ingestionMarkers(reviewId!)).toEqual([
      { origin: 'imported', account_id: tenantAccountId(), run_status: 'completed' },
    ]);
    expect(await postedResponseCount(reviewId!)).toBe(1);

    // Same payload again: the existing row is returned, no second marker/run.
    await reconcileExternallyAnsweredReview(
      sql(), review, businessId, zernioAccountId, zernioLocationId, logger, { consentedImport: true },
    );

    expect(await reviewIds(review)).toEqual([reviewId]);
    expect(await ingestionMarkers(reviewId!)).toEqual([
      { origin: 'imported', account_id: tenantAccountId(), run_status: 'completed' },
    ]);
    expect(await postedResponseCount(reviewId!)).toBe(1);
  });

  it('attaching an external reply to an existing live review keeps its live marker and run', async () => {
    const review = mkZernioReview('attach');
    const monitored = buildZernioMonitoredReview(review, zernioAccountId, zernioLocationId);

    expect(await processReview(sql(), monitored, businessId, 'corr-origin-attach')).toBe('new');
    const [reviewId] = await reviewIds(review);
    expect(await ingestionMarkers(reviewId!)).toEqual([
      { origin: 'live', account_id: tenantAccountId(), run_status: 'running' },
    ]);

    await reconcileExternallyAnsweredReview(
      sql(), review, businessId, zernioAccountId, zernioLocationId, logger, { consentedImport: true },
    );

    expect(await reviewIds(review)).toEqual([reviewId]);
    // Still live, still the live lane's running run — the import neither
    // relabeled it nor completed it.
    expect(await ingestionMarkers(reviewId!)).toEqual([
      { origin: 'live', account_id: tenantAccountId(), run_status: 'running' },
    ]);
    expect(await postedResponseCount(reviewId!)).toBe(1);
  });

  it('a same-identity insert race keeps only the live winner marker', async () => {
    const review = mkZernioReview('race');
    const monitored = buildZernioMonitoredReview(review, zernioAccountId, zernioLocationId);
    const [racerBackend] = await racerSql()<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;

    let importRace: Promise<void> | undefined;
    let importSettled = false;

    // The live lane has inserted (uncommitted) and written its marker. Only now
    // start the answered import: its matched-rows SELECT cannot see the row, so
    // it reaches insertImportedReview and its INSERT waits on the unique key.
    const holder = executorHoldingCommit(sql(), async (tx) => {
      importRace = reconcileExternallyAnsweredReview(
        racerSql(), review, businessId, zernioAccountId, zernioLocationId, logger, { consentedImport: true },
      );
      importRace.then(() => { importSettled = true; }, () => { importSettled = true; });
      await waitUntilBlockedBy(tx, racerBackend!.pid, () => importSettled);
    });

    expect(await processReview(holder, monitored, businessId, 'corr-origin-race')).toBe('new');
    // The live commit releases the key; the import's DO UPDATE arm returns the
    // winner's id, not its minted one.
    await importRace;

    const ids = await reviewIds(review);
    expect(ids).toHaveLength(1);
    expect(await ingestionMarkers(ids[0]!)).toEqual([
      { origin: 'live', account_id: tenantAccountId(), run_status: 'running' },
    ]);
    // The loser still attached the external reply to the winner row.
    expect(await postedResponseCount(ids[0]!)).toBe(1);
  });

  it('a forced rollback removes the imported review and its marker together', async () => {
    const review = mkZernioReview('rollback');
    const runsBefore = await reviewRunCount();

    await expect(
      reconcileExternallyAnsweredReview(
        abortingExecutor(sql(), divisionByZero),
        review, businessId, zernioAccountId, zernioLocationId, logger, { consentedImport: true },
      ),
    ).rejects.toThrow(/division by zero/);

    expect(await reviewIds(review)).toEqual([]);
    expect(await reviewRunCount()).toBe(runsBefore);
  });
});
