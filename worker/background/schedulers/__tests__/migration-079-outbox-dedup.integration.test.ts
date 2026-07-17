// worker/background/schedulers/__tests__/migration-079-outbox-dedup.integration.test.ts
//
// Behavioral DB-level coverage for migration 079's two guarantees on
// job_outbox, exercised against a real Postgres where 079 is ALREADY applied
// (CI applies every supabase/migrations/*.sql to an empty DB before this suite):
//
//   (a) PREFLIGHT REGRESSION — 079's one-time race-safe preflight ran against an
//       EMPTY DB in CI, so it never collapsed a real duplicate. This suite seeds
//       duplicate in-flight fixtures and executes a COPY of that preflight UPDATE
//       (see `runWeeklyPreflight` — SOURCE OF TRUTH is the migration) to prove:
//       most-advanced-then-oldest is KEPT, only currently-`pending` extras are
//       failed, `dispatching`/`dispatched` rows are never touched, and
//       NULL-period rows are excluded.
//
//   (b) INDEX SEMANTICS — with `uniq_outbox_weekly_summary_week` present, a
//       second IN-FLIGHT row for the same (aggregate_id, week) is rejected (the
//       ON CONFLICT DO NOTHING the collapsed scheduler relies on inserts 0), and
//       a fresh in-flight row IS permitted once the prior row is `completed` OR
//       `failed` (the in-flight-only predicate keeps completed-but-not-sent /
//       failed rows re-enqueueable — finding-1 regression guard).
//
// job_outbox.aggregate_id has NO foreign key, so this suite seeds job_outbox
// rows directly under a private aggregate_id namespace — no business/account
// seeding needed. The preflight COPY and every assertion are scoped to that
// namespace; nothing here asserts a global count, so a shared test DB with other
// tenants' due rows is unaffected. All seeded rows are deleted in afterAll.
//
// Gated on TEST_DATABASE_POOL_URL like the repo's other live-DB integration
// tests (see summary-schedulers-archived.integration.test.ts); skips cleanly
// without one. The database is expected to already have all migrations applied.

import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import postgres from 'postgres';
import type postgresType from 'postgres';
import { v7 as uuidv7 } from 'uuid';
import { randomUUID } from 'node:crypto';
import { describeWithDb } from '../../../../src/__tests__/helpers/describe-with-db';

const testDatabaseUrl = process.env.TEST_DATABASE_POOL_URL;

const WEEK = '2026-05-25'; // Monday — the weekly period key for every fixture below.

let db: postgresType.Sql | undefined;

// Every aggregate_id this suite touches, for a scoped cleanup that never spills
// into other tenants' rows on a shared DB.
const seededAggregateIds = new Set<string>();

function sql(): postgresType.Sql {
  if (!db) throw new Error('migration-079 integration database was not initialized');
  return db;
}

type OutboxStatus = 'pending' | 'dispatching' | 'dispatched' | 'completed' | 'failed';

/**
 * Inserts one job_outbox row and returns its id. `week` = null omits the
 * week_start_date key entirely (so payload->>'week_start_date' IS NULL).
 * `createdAt` pins ordering for the deterministic keep-oldest assertions.
 */
async function insertWeeklyOutboxRow(opts: {
  aggregateId: string;
  status: OutboxStatus;
  week: string | null;
  createdAt: Date;
}): Promise<string> {
  const id = uuidv7();
  seededAggregateIds.add(opts.aggregateId);
  const payload: Record<string, string> = { business_id: opts.aggregateId };
  if (opts.week !== null) payload.week_start_date = opts.week;
  await sql()`
    INSERT INTO job_outbox (id, topic, aggregate_type, aggregate_id, payload, status, created_at)
    VALUES (
      ${id}::uuid, 'weekly_summary', 'business', ${opts.aggregateId}::uuid,
      ${sql().json(payload)}, ${opts.status}, ${opts.createdAt}
    )
  `;
  return id;
}

async function statusOf(id: string): Promise<string> {
  const [row] = await sql()<{ status: string }[]>`
    SELECT status FROM job_outbox WHERE id = ${id}::uuid
  `;
  if (!row) throw new Error(`job_outbox row ${id} not found`);
  return row.status;
}

/**
 * A COPY of migration 079's weekly_summary preflight UPDATE, scoped to a private
 * aggregate_id namespace so it stays tenant-safe on a shared DB. The ranking +
 * live-CAS logic is IDENTICAL to the migration; only the extra
 * `AND aggregate_id = ANY(...)` namespace filter is added.
 *
 * -- SOURCE OF TRUTH: supabase/migrations/079_scheduler_outbox_dedup_indexes.sql
 */
async function runWeeklyPreflight(aggregateIds: string[]): Promise<void> {
  await sql()`
    WITH ranked AS (
      SELECT id, status,
        ROW_NUMBER() OVER (
          PARTITION BY aggregate_id, payload->>'week_start_date'
          ORDER BY CASE status WHEN 'dispatched' THEN 0 WHEN 'dispatching' THEN 1 ELSE 2 END, created_at
        ) AS rn
      FROM job_outbox
      WHERE topic = 'weekly_summary'
        AND status IN ('pending','dispatching','dispatched')
        AND payload->>'week_start_date' IS NOT NULL
        AND aggregate_id = ANY(${aggregateIds}::uuid[])
    )
    UPDATE job_outbox SET status = 'failed', last_error = 'migration 079: collapsed pending duplicate'
    WHERE id IN (SELECT id FROM ranked WHERE rn > 1)
      AND status = 'pending'
  `;
}

describeWithDb('Migration 079 outbox dedup — preflight + index semantics (live DB)', () => {
  beforeAll(() => {
    db = postgres(testDatabaseUrl!, { max: 1, prepare: false });
  });

  afterEach(async () => {
    if (db && seededAggregateIds.size > 0) {
      const ids = [...seededAggregateIds];
      await sql()`
        DELETE FROM job_outbox
        WHERE topic = 'weekly_summary' AND aggregate_id = ANY(${ids}::uuid[])
      `;
      seededAggregateIds.clear();
    }
  });

  afterAll(async () => {
    if (db) await db.end({ timeout: 5 });
  });

  // -- (a) PREFLIGHT REGRESSION ------------------------------------------------

  it('collapses two pending dups → exactly one survives, the other failed', async () => {
    const agg = randomUUID();
    const kept = await insertWeeklyOutboxRow({
      aggregateId: agg,
      status: 'pending',
      week: WEEK,
      createdAt: new Date('2026-05-25T08:00:00Z'), // older → kept
    });
    const collapsed = await insertWeeklyOutboxRow({
      aggregateId: agg,
      status: 'pending',
      week: WEEK,
      createdAt: new Date('2026-05-25T08:05:00Z'), // newer → failed
    });

    await runWeeklyPreflight([agg]);

    expect(await statusOf(kept)).toBe('pending');
    expect(await statusOf(collapsed)).toBe('failed');
  });

  it('keeps a newer dispatched row over an older pending dup, failing the pending', async () => {
    const agg = randomUUID();
    const pendingRow = await insertWeeklyOutboxRow({
      aggregateId: agg,
      status: 'pending',
      week: WEEK,
      createdAt: new Date('2026-05-25T08:00:00Z'), // older, but less-advanced
    });
    const dispatchedRow = await insertWeeklyOutboxRow({
      aggregateId: agg,
      status: 'dispatched',
      week: WEEK,
      createdAt: new Date('2026-05-25T08:05:00Z'), // newer, but more-advanced → KEPT
    });

    await runWeeklyPreflight([agg]);

    expect(await statusOf(dispatchedRow)).toBe('dispatched');
    expect(await statusOf(pendingRow)).toBe('failed');
  });

  it('in a 3-way dispatched+dispatching+pending group, fails only the pending', async () => {
    const agg = randomUUID();
    const dispatchedRow = await insertWeeklyOutboxRow({
      aggregateId: agg,
      status: 'dispatched',
      week: WEEK,
      createdAt: new Date('2026-05-25T08:00:00Z'),
    });
    const dispatchingRow = await insertWeeklyOutboxRow({
      aggregateId: agg,
      status: 'dispatching',
      week: WEEK,
      createdAt: new Date('2026-05-25T08:05:00Z'),
    });
    const pendingRow = await insertWeeklyOutboxRow({
      aggregateId: agg,
      status: 'pending',
      week: WEEK,
      createdAt: new Date('2026-05-25T08:10:00Z'),
    });

    await runWeeklyPreflight([agg]);

    expect(await statusOf(dispatchedRow)).toBe('dispatched');
    expect(await statusOf(dispatchingRow)).toBe('dispatching');
    expect(await statusOf(pendingRow)).toBe('failed');
  });

  it('leaves NULL-week rows untouched', async () => {
    const agg = randomUUID();
    const row1 = await insertWeeklyOutboxRow({
      aggregateId: agg,
      status: 'pending',
      week: null,
      createdAt: new Date('2026-05-25T08:00:00Z'),
    });
    const row2 = await insertWeeklyOutboxRow({
      aggregateId: agg,
      status: 'pending',
      week: null,
      createdAt: new Date('2026-05-25T08:05:00Z'),
    });

    await runWeeklyPreflight([agg]);

    expect(await statusOf(row1)).toBe('pending');
    expect(await statusOf(row2)).toBe('pending');
  });

  // -- (b) INDEX SEMANTICS -----------------------------------------------------

  it('rejects a second in-flight row for the same (aggregate_id, week)', async () => {
    const agg = randomUUID();
    await insertWeeklyOutboxRow({
      aggregateId: agg,
      status: 'pending',
      week: WEEK,
      createdAt: new Date('2026-05-25T08:00:00Z'),
    });

    // The collapsed scheduler's ON CONFLICT DO NOTHING must absorb the duplicate
    // (0 rows inserted), never surface a 23505.
    seededAggregateIds.add(agg);
    const inserted = await sql()`
      INSERT INTO job_outbox (id, topic, aggregate_type, aggregate_id, payload, status)
      VALUES (
        ${uuidv7()}::uuid, 'weekly_summary', 'business', ${agg}::uuid,
        ${sql().json({ business_id: agg, week_start_date: WEEK })}, 'pending'
      )
      ON CONFLICT DO NOTHING
    `;
    expect(inserted.count).toBe(0);
  });

  it('permits a fresh in-flight row once the prior is completed or failed', async () => {
    for (const priorStatus of ['completed', 'failed'] as const) {
      const agg = randomUUID();
      await insertWeeklyOutboxRow({
        aggregateId: agg,
        status: priorStatus,
        week: WEEK,
        createdAt: new Date('2026-05-25T08:00:00Z'),
      });

      seededAggregateIds.add(agg);
      const inserted = await sql()`
        INSERT INTO job_outbox (id, topic, aggregate_type, aggregate_id, payload, status)
        VALUES (
          ${uuidv7()}::uuid, 'weekly_summary', 'business', ${agg}::uuid,
          ${sql().json({ business_id: agg, week_start_date: WEEK })}, 'pending'
        )
        ON CONFLICT DO NOTHING
      `;
      expect(inserted.count).toBe(1);
    }
  });
});
