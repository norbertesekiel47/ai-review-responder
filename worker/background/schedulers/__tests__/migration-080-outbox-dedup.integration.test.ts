// worker/background/schedulers/__tests__/migration-080-outbox-dedup.integration.test.ts
//
// Behavioral DB-level coverage for migration 080's two guarantees on
// job_outbox, exercised against a real Postgres where 080 is ALREADY applied
// (CI applies every supabase/migrations/*.sql to an empty DB before this suite):
//
//   (a) PREFLIGHT REGRESSION — 080's one-time race-safe preflight ran against an
//       EMPTY DB in CI, so it never collapsed a real duplicate. We prove the
//       preflight UPDATE against a PRE-INDEX state: because the real job_outbox
//       is already indexed by 080, seeding two in-flight duplicates into it would
//       hit the partial unique index (23505) before the preflight could run. So
//       each preflight scenario runs inside ONE transaction against a session-
//       local `CREATE TEMP TABLE job_outbox (LIKE public.job_outbox …)` that
//       copies NO indexes — duplicates seed freely, pg_temp shadows public in the
//       search_path so the UNQUALIFIED `job_outbox` in the migration-COPY SQL
//       resolves to the temp copy, and `ON COMMIT DROP` auto-cleans it. This
//       isolates the preflight from the shared table and from concurrent test
//       files. Each scenario proves: most-advanced-then-oldest is KEPT, only
//       currently-`pending` extras are failed, `dispatching`/`dispatched` rows are
//       never touched, NULL-period rows are excluded — then rebuilds the real 080
//       unique index on the temp table to prove the preflight left a conflict-free
//       state.
//
//   (b) INDEX SEMANTICS — against the REAL, already-indexed job_outbox: with
//       `uniq_outbox_weekly_summary_week` present, a second IN-FLIGHT row for the
//       same (aggregate_id, week) is rejected (the ON CONFLICT DO NOTHING the
//       collapsed scheduler relies on inserts 0), and a fresh in-flight row IS
//       permitted once the prior row is `completed` OR `failed` (the in-flight-only
//       predicate keeps completed-but-not-sent / failed rows re-enqueueable —
//       finding-1 regression guard). These test the runtime production guarantee
//       and must stay on the real indexed table; they seed under a private,
//       test-namespaced aggregate_id and clean up in afterEach.
//
// job_outbox.aggregate_id has NO foreign key, so this suite seeds job_outbox
// rows directly under a private aggregate_id namespace — no business/account
// seeding needed. Nothing here asserts a global count, so a shared test DB with
// other tenants' due rows is unaffected.
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
const MONTH = '2026-05-01'; // month-start key for the monthly fixtures.

let db: postgresType.Sql | undefined;

// aggregate_ids the INDEX-SEMANTICS scenarios seed into the REAL table, for a
// scoped cleanup that never spills into other tenants' rows on a shared DB. The
// PREFLIGHT scenarios use an ON COMMIT DROP temp table and need no cleanup here.
const seededAggregateIds = new Set<string>();

function sql(): postgresType.Sql {
  if (!db) throw new Error('migration-080 integration database was not initialized');
  return db;
}

type OutboxStatus = 'pending' | 'dispatching' | 'dispatched' | 'completed' | 'failed';

// -- temp-table preflight helpers (run inside one transaction per scenario) -----

/**
 * Creates a session-local `job_outbox` shadow copy on the CURRENT connection.
 * `LIKE public.job_outbox INCLUDING DEFAULTS` copies columns + defaults but NO
 * indexes/constraints, so duplicates can be seeded. `ON COMMIT DROP` removes it
 * when the wrapping `sql().begin()` transaction commits. pg_temp precedes public
 * in the search_path, so every UNQUALIFIED `job_outbox` reference below (seed,
 * preflight, index build, assert) resolves to this temp copy.
 */
async function createTempOutbox(tx: postgresType.TransactionSql): Promise<void> {
  // live-db-ddl-ignore: pg_temp, ON COMMIT DROP — locks no shared relation
  await tx`CREATE TEMP TABLE job_outbox (LIKE public.job_outbox INCLUDING DEFAULTS) ON COMMIT DROP`;
}

/**
 * Inserts one row into the UNQUALIFIED (temp) job_outbox and returns its id.
 * `period = null` omits the period key entirely (so payload->>'…' IS NULL).
 * `createdAt` pins ordering for the deterministic keep-oldest assertions.
 */
async function insertTempOutboxRow(
  tx: postgresType.TransactionSql,
  opts: {
    topic: 'weekly_summary' | 'send_monthly_impact';
    periodKey: 'week_start_date' | 'month_start_date';
    aggregateId: string;
    status: OutboxStatus;
    period: string | null;
    createdAt: Date;
  },
): Promise<string> {
  const id = uuidv7();
  const payload: Record<string, string> = { business_id: opts.aggregateId };
  if (opts.period !== null) payload[opts.periodKey] = opts.period;
  await tx`
    INSERT INTO job_outbox (id, topic, aggregate_type, aggregate_id, payload, status, created_at)
    VALUES (
      ${id}::uuid, ${opts.topic}, 'business', ${opts.aggregateId}::uuid,
      ${tx.json(payload)}, ${opts.status}, ${opts.createdAt}
    )
  `;
  return id;
}

async function statusOfTemp(tx: postgresType.TransactionSql, id: string): Promise<string> {
  const [row] = await tx<{ status: string }[]>`
    SELECT status FROM job_outbox WHERE id = ${id}::uuid
  `;
  if (!row) throw new Error(`temp job_outbox row ${id} not found`);
  return row.status;
}

/**
 * An EXACT copy of migration 080's weekly_summary preflight UPDATE, run against
 * the UNQUALIFIED (temp) job_outbox. The temp table holds ONLY this scenario's
 * rows, so the migration's `aggregate_id = ANY(...)` namespace filter is dropped
 * and this is byte-identical to the migration statement.
 *
 * -- SOURCE OF TRUTH: supabase/migrations/080_scheduler_outbox_dedup_indexes.sql
 */
async function runWeeklyPreflight(tx: postgresType.TransactionSql): Promise<void> {
  await tx`
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
    )
    UPDATE job_outbox SET status = 'failed', last_error = 'migration 080: collapsed pending duplicate'
    WHERE id IN (SELECT id FROM ranked WHERE rn > 1)
      AND status = 'pending'
  `;
}

/**
 * An EXACT copy of migration 080's send_monthly_impact preflight UPDATE, run
 * against the UNQUALIFIED (temp) job_outbox. Same reasoning as the weekly copy.
 *
 * -- SOURCE OF TRUTH: supabase/migrations/080_scheduler_outbox_dedup_indexes.sql
 */
async function runMonthlyPreflight(tx: postgresType.TransactionSql): Promise<void> {
  await tx`
    WITH ranked AS (
      SELECT id, status,
        ROW_NUMBER() OVER (
          PARTITION BY aggregate_id, payload->>'month_start_date'
          ORDER BY CASE status WHEN 'dispatched' THEN 0 WHEN 'dispatching' THEN 1 ELSE 2 END, created_at
        ) AS rn
      FROM job_outbox
      WHERE topic = 'send_monthly_impact'
        AND status IN ('pending','dispatching','dispatched')
        AND payload->>'month_start_date' IS NOT NULL
    )
    UPDATE job_outbox SET status = 'failed', last_error = 'migration 080: collapsed pending duplicate'
    WHERE id IN (SELECT id FROM ranked WHERE rn > 1)
      AND status = 'pending'
  `;
}

/**
 * Rebuilds migration 080's real unique index on the temp table. It BUILDS only
 * if the preflight left a conflict-free in-flight set — the strongest proof the
 * preflight did its job. Byte-identical predicate to the migration.
 *
 * -- SOURCE OF TRUTH: supabase/migrations/080_scheduler_outbox_dedup_indexes.sql
 */
async function buildWeeklyIndex(tx: postgresType.TransactionSql): Promise<void> {
  await tx`
    -- live-db-ddl-ignore: builds on the pg_temp job_outbox above, not public
    CREATE UNIQUE INDEX uniq_outbox_weekly_summary_week
      ON job_outbox(aggregate_id, (payload->>'week_start_date'))
      WHERE topic = 'weekly_summary' AND status IN ('pending','dispatching','dispatched')
  `;
}

async function buildMonthlyIndex(tx: postgresType.TransactionSql): Promise<void> {
  await tx`
    -- live-db-ddl-ignore: builds on the pg_temp job_outbox above, not public
    CREATE UNIQUE INDEX uniq_outbox_monthly_impact_month
      ON job_outbox(aggregate_id, (payload->>'month_start_date'))
      WHERE topic = 'send_monthly_impact' AND status IN ('pending','dispatching','dispatched')
  `;
}

// -- real-table helpers (INDEX-SEMANTICS scenarios) -----------------------------

/**
 * Inserts one weekly_summary row into the REAL job_outbox and returns its id.
 * Used only by the INDEX-SEMANTICS scenarios, which must run against the live
 * indexed table. Tracks the aggregate_id for afterEach cleanup.
 */
async function insertRealWeeklyRow(opts: {
  aggregateId: string;
  status: OutboxStatus;
  week: string;
  createdAt: Date;
}): Promise<string> {
  const id = uuidv7();
  seededAggregateIds.add(opts.aggregateId);
  await sql()`
    INSERT INTO job_outbox (id, topic, aggregate_type, aggregate_id, payload, status, created_at)
    VALUES (
      ${id}::uuid, 'weekly_summary', 'business', ${opts.aggregateId}::uuid,
      ${sql().json({ business_id: opts.aggregateId, week_start_date: opts.week })},
      ${opts.status}, ${opts.createdAt}
    )
  `;
  return id;
}

describeWithDb('Migration 080 outbox dedup — preflight + index semantics (live DB)', () => {
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

  // -- (a) PREFLIGHT REGRESSION (against a PRE-INDEX temp table) ----------------

  it('collapses two pending dups → exactly one survives, the other failed', async () => {
    await sql().begin(async (tx) => {
      await createTempOutbox(tx);
      const agg = randomUUID();
      const kept = await insertTempOutboxRow(tx, {
        topic: 'weekly_summary',
        periodKey: 'week_start_date',
        aggregateId: agg,
        status: 'pending',
        period: WEEK,
        createdAt: new Date('2026-05-25T08:00:00Z'), // older → kept
      });
      const collapsed = await insertTempOutboxRow(tx, {
        topic: 'weekly_summary',
        periodKey: 'week_start_date',
        aggregateId: agg,
        status: 'pending',
        period: WEEK,
        createdAt: new Date('2026-05-25T08:05:00Z'), // newer → failed
      });

      await runWeeklyPreflight(tx);

      expect(await statusOfTemp(tx, kept)).toBe('pending');
      expect(await statusOfTemp(tx, collapsed)).toBe('failed');

      // Preflight left a conflict-free in-flight set → the real 080 index builds.
      await buildWeeklyIndex(tx);
    });
  });

  it('keeps a newer dispatched row over an older pending dup, failing the pending', async () => {
    await sql().begin(async (tx) => {
      await createTempOutbox(tx);
      const agg = randomUUID();
      const pendingRow = await insertTempOutboxRow(tx, {
        topic: 'weekly_summary',
        periodKey: 'week_start_date',
        aggregateId: agg,
        status: 'pending',
        period: WEEK,
        createdAt: new Date('2026-05-25T08:00:00Z'), // older, but less-advanced
      });
      const dispatchedRow = await insertTempOutboxRow(tx, {
        topic: 'weekly_summary',
        periodKey: 'week_start_date',
        aggregateId: agg,
        status: 'dispatched',
        period: WEEK,
        createdAt: new Date('2026-05-25T08:05:00Z'), // newer, but more-advanced → KEPT
      });

      await runWeeklyPreflight(tx);

      expect(await statusOfTemp(tx, dispatchedRow)).toBe('dispatched');
      expect(await statusOfTemp(tx, pendingRow)).toBe('failed');

      await buildWeeklyIndex(tx);
    });
  });

  it('in a 3-way dispatched+dispatching+pending group, fails only the pending', async () => {
    await sql().begin(async (tx) => {
      await createTempOutbox(tx);
      const agg = randomUUID();
      const dispatchedRow = await insertTempOutboxRow(tx, {
        topic: 'weekly_summary',
        periodKey: 'week_start_date',
        aggregateId: agg,
        status: 'dispatched',
        period: WEEK,
        createdAt: new Date('2026-05-25T08:00:00Z'),
      });
      const dispatchingRow = await insertTempOutboxRow(tx, {
        topic: 'weekly_summary',
        periodKey: 'week_start_date',
        aggregateId: agg,
        status: 'dispatching',
        period: WEEK,
        createdAt: new Date('2026-05-25T08:05:00Z'),
      });
      const pendingRow = await insertTempOutboxRow(tx, {
        topic: 'weekly_summary',
        periodKey: 'week_start_date',
        aggregateId: agg,
        status: 'pending',
        period: WEEK,
        createdAt: new Date('2026-05-25T08:10:00Z'),
      });

      await runWeeklyPreflight(tx);

      expect(await statusOfTemp(tx, dispatchedRow)).toBe('dispatched');
      expect(await statusOfTemp(tx, dispatchingRow)).toBe('dispatching');
      expect(await statusOfTemp(tx, pendingRow)).toBe('failed');
      // No index build here: this scenario deliberately leaves two in-flight rows
      // (dispatched + dispatching) for one key, which the unique index would
      // (correctly) reject — matching the migration's "fails LOUDLY" note. The
      // index-BUILDS proof lives on the conflict-free scenarios above/below.
    });
  });

  it('leaves NULL-week rows untouched', async () => {
    await sql().begin(async (tx) => {
      await createTempOutbox(tx);
      const agg = randomUUID();
      const row1 = await insertTempOutboxRow(tx, {
        topic: 'weekly_summary',
        periodKey: 'week_start_date',
        aggregateId: agg,
        status: 'pending',
        period: null,
        createdAt: new Date('2026-05-25T08:00:00Z'),
      });
      const row2 = await insertTempOutboxRow(tx, {
        topic: 'weekly_summary',
        periodKey: 'week_start_date',
        aggregateId: agg,
        status: 'pending',
        period: null,
        createdAt: new Date('2026-05-25T08:05:00Z'),
      });

      await runWeeklyPreflight(tx);

      expect(await statusOfTemp(tx, row1)).toBe('pending');
      expect(await statusOfTemp(tx, row2)).toBe('pending');

      // NULL period keys are distinct in the (NULLs-distinct) unique index, so
      // both untouched rows still let the index build.
      await buildWeeklyIndex(tx);
    });
  });

  it('monthly: in a 3-way dispatched+dispatching+pending group, fails only the pending', async () => {
    await sql().begin(async (tx) => {
      await createTempOutbox(tx);
      const agg = randomUUID();
      const dispatchedRow = await insertTempOutboxRow(tx, {
        topic: 'send_monthly_impact',
        periodKey: 'month_start_date',
        aggregateId: agg,
        status: 'dispatched',
        period: MONTH,
        createdAt: new Date('2026-05-01T08:00:00Z'),
      });
      const dispatchingRow = await insertTempOutboxRow(tx, {
        topic: 'send_monthly_impact',
        periodKey: 'month_start_date',
        aggregateId: agg,
        status: 'dispatching',
        period: MONTH,
        createdAt: new Date('2026-05-01T08:05:00Z'),
      });
      const pendingRow = await insertTempOutboxRow(tx, {
        topic: 'send_monthly_impact',
        periodKey: 'month_start_date',
        aggregateId: agg,
        status: 'pending',
        period: MONTH,
        createdAt: new Date('2026-05-01T08:10:00Z'),
      });

      await runMonthlyPreflight(tx);

      expect(await statusOfTemp(tx, dispatchedRow)).toBe('dispatched');
      expect(await statusOfTemp(tx, dispatchingRow)).toBe('dispatching');
      expect(await statusOfTemp(tx, pendingRow)).toBe('failed');
    });
  });

  it('monthly: collapses two pending dups → one survives, the other failed, index builds', async () => {
    await sql().begin(async (tx) => {
      await createTempOutbox(tx);
      const agg = randomUUID();
      const kept = await insertTempOutboxRow(tx, {
        topic: 'send_monthly_impact',
        periodKey: 'month_start_date',
        aggregateId: agg,
        status: 'pending',
        period: MONTH,
        createdAt: new Date('2026-05-01T08:00:00Z'),
      });
      const collapsed = await insertTempOutboxRow(tx, {
        topic: 'send_monthly_impact',
        periodKey: 'month_start_date',
        aggregateId: agg,
        status: 'pending',
        period: MONTH,
        createdAt: new Date('2026-05-01T08:05:00Z'),
      });

      await runMonthlyPreflight(tx);

      expect(await statusOfTemp(tx, kept)).toBe('pending');
      expect(await statusOfTemp(tx, collapsed)).toBe('failed');

      await buildMonthlyIndex(tx);
    });
  });

  // -- (b) INDEX SEMANTICS (against the REAL, already-indexed table) ------------

  it('rejects a second in-flight row for the same (aggregate_id, week)', async () => {
    const agg = randomUUID();
    await insertRealWeeklyRow({
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
      await insertRealWeeklyRow({
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
