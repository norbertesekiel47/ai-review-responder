// #1365 — the admin jobs + overview panels read BOUNDED sets, and the bounds
// change no number. Live-Postgres suite.
//
// Three things are pinned, each against the real planner/catalogue rather
// than a mock (a mock returns whatever the query author believed the query
// said):
//
//  1. Migration 124's two indexes exist, are valid+ready, and carry the exact
//     key / INCLUDE / predicate the reads depend on.
//  2. EQUIVALENCE: inside one REPEATABLE READ snapshot, `getAdminJobsData`'s
//     outbox summary and `getAdminOverview`'s email health equal the
//     WHERE-less whole-table queries they replaced. The fixtures are the edge
//     rows a wrong bound would drop — a delivery CREATED 30 days ago that
//     FAILED yesterday, a failed job created 80 days ago, a job completed
//     today that was created 10 days ago — so e.g. a `created_at >= 7 days`
//     bound on email health fails here instead of silently under-counting.
//  3. PLAN: with sequential scans priced out, the failed-row reads and the
//     summary resolve to migration 124's indexes (a bare-status `IN (…)` list
//     in the summary would not — it implies no partial predicate).
//
// No DDL and no migration SQL at run time (`ci:live-db-suites`): `pnpm
// test:db:setup` provisions the schema, `assertSchemaReady` asserts it, and
// fixtures are INSERT-only, removed in afterAll. No live-DB lock: nothing
// here depends on another suite's rows being absent — the equivalence runs
// against whatever else is in the table, inside one snapshot.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import postgres from 'postgres';
import type postgresType from 'postgres';
import { describeWithDb } from '@/__tests__/helpers/describe-with-db';
import {
  assertLocalTestDatabaseUrl,
  resolveTestDatabaseUrl,
} from '@/lib/shared/__tests__/helpers/live-db-lock';
import {
  assertSchemaReady,
  type SchemaRequirement,
} from '@/lib/shared/__tests__/helpers/schema-ready';
import {
  cleanupLocation,
  cleanupTenantAccount,
  seedLocation,
  seedTenantAccount,
  type TenantSeed,
} from '@/lib/shared/__tests__/live-db-tenant';
import { getAdminJobsData } from '../jobs-service';
import { getAdminOverview } from '../overview-service';

const MIGRATION_124_ADMIN_OUTBOX_PANEL_INDEXES: SchemaRequirement = {
  migration: '124_admin_outbox_panel_indexes',
  indexes: ['idx_jo_failed_created', 'idx_jo_completed_at'],
};

/** A topic no producer uses, so fixture rows are unambiguous and removable. */
const FIXTURE_TOPIC = 'admin_panel_bounds_1365_fixture';

const testDatabaseUrl = resolveTestDatabaseUrl();

let db: postgresType.Sql | undefined;
let tenant: TenantSeed | undefined;
let businessId: string | undefined;

function sql(): postgresType.Sql {
  if (!db) throw new Error('admin panel bounds integration database was not initialized');
  return db;
}

interface IndexCatalogRow {
  indexdef: string;
  indisvalid: boolean;
  indisready: boolean;
}

async function fetchIndex(name: string): Promise<IndexCatalogRow | undefined> {
  const [row] = await sql()<IndexCatalogRow[]>`
    SELECT pg_get_indexdef(i.indexrelid) AS indexdef, i.indisvalid, i.indisready
    FROM pg_index i
    JOIN pg_class idx ON idx.oid = i.indexrelid
    JOIN pg_namespace ns ON ns.oid = idx.relnamespace
    WHERE ns.nspname = 'public' AND idx.relname = ${name}
  `;
  return row;
}

/** Every index name in a JSON plan, depth-first. */
function planIndexNames(node: unknown): string[] {
  if (!node || typeof node !== 'object') return [];
  const record = node as Record<string, unknown>;
  const own = typeof record['Index Name'] === 'string' ? [record['Index Name']] : [];
  const children = Array.isArray(record.Plans) ? record.Plans : [];
  return [...own, ...children.flatMap(planIndexNames)];
}

/** EXPLAIN (FORMAT JSON) with sequential scans priced out, in a rolled-back tx. */
async function explainIndexes(query: string, params: unknown[]): Promise<string[]> {
  let names: string[] = [];
  await sql()
    .begin(async (tx) => {
      await tx`SET LOCAL enable_seqscan = off`;
      const rows = await tx.unsafe<{ 'QUERY PLAN': unknown }[]>(
        `EXPLAIN (FORMAT JSON) ${query}`,
        params as postgresType.ParameterOrJSON<never>[],
      );
      const raw = rows[0]?.['QUERY PLAN'];
      const plan: unknown = typeof raw === 'string' ? JSON.parse(raw) : raw;
      const top = Array.isArray(plan) ? (plan[0] as { Plan?: unknown }).Plan : undefined;
      names = planIndexNames(top);
      throw new RollbackSignal();
    })
    .catch((error: unknown) => {
      if (!(error instanceof RollbackSignal)) throw error;
    });
  return names;
}

class RollbackSignal extends Error {}

describeWithDb('admin panel bounded reads (#1365)', { enabled: Boolean(testDatabaseUrl), timeout: 60_000 }, () => {
  beforeAll(async () => {
    db = postgres(assertLocalTestDatabaseUrl(testDatabaseUrl), { max: 1, prepare: false });
    await assertSchemaReady(db, [MIGRATION_124_ADMIN_OUTBOX_PANEL_INDEXES]);

    tenant = await seedTenantAccount(db, { accountDisplayName: 'Admin Bounds 1365' });
    ({ businessId } = await seedLocation(db, tenant.accountId, { name: 'Admin Bounds 1365' }));

    // job_outbox edge rows. Terminal statuses only, so no poller ever claims one.
    await db`
      INSERT INTO job_outbox (id, topic, aggregate_type, payload, status, created_at, completed_at, last_error)
      VALUES
        -- failed long ago: inside the failed count / page / topics at any age
        (${randomUUID()}::uuid, ${FIXTURE_TOPIC}, 'test', '{}'::jsonb, 'failed',
         NOW() - INTERVAL '80 days', NOW() - INTERVAL '80 days', 'fixture'),
        -- completed today, created 10 days ago: counted by completed_today
        (${randomUUID()}::uuid, ${FIXTURE_TOPIC}, 'test', '{}'::jsonb, 'completed',
         NOW() - INTERVAL '10 days', CURRENT_DATE::timestamptz, NULL),
        -- completed before today: counted by nothing
        (${randomUUID()}::uuid, ${FIXTURE_TOPIC}, 'test', '{}'::jsonb, 'completed',
         NOW() - INTERVAL '2 days', CURRENT_DATE::timestamptz - INTERVAL '1 second', NULL)
    `;

    // notification_deliveries edge rows.
    await db`
      INSERT INTO notification_deliveries
        (id, business_id, account_id, channel, recipient, template, created_at, sent_at, delivered_at, failed_at, failure_reason)
      VALUES
        -- CREATED 30 days ago, hard-bounced yesterday: in bounces_7d + hard_bounces_7d
        (${randomUUID()}::uuid, ${businessId}::uuid, ${tenant.accountId}::uuid, 'email', 'fixture', 'fixture',
         NOW() - INTERVAL '30 days', NOW() - INTERVAL '30 days', NULL, NOW() - INTERVAL '1 day', 'bounced:hard:fixture'),
        -- CREATED 10 days ago, sent + delivered an hour ago: in sent_24h + delivered_24h
        (${randomUUID()}::uuid, ${businessId}::uuid, ${tenant.accountId}::uuid, 'email', 'fixture', 'fixture',
         NOW() - INTERVAL '10 days', NOW() - INTERVAL '1 hour', NOW() - INTERVAL '1 hour', NULL, NULL),
        -- complained 8 days ago: outside every window
        (${randomUUID()}::uuid, ${businessId}::uuid, ${tenant.accountId}::uuid, 'email', 'fixture', 'fixture',
         NOW() - INTERVAL '8 days', NOW() - INTERVAL '8 days', NULL, NOW() - INTERVAL '8 days', 'complained')
    `;
  });

  afterAll(async () => {
    if (!db) return;
    await db`DELETE FROM job_outbox WHERE topic = ${FIXTURE_TOPIC}`;
    if (businessId) {
      await db`DELETE FROM notification_deliveries WHERE business_id = ${businessId}::uuid`;
      await cleanupLocation(db, businessId);
    }
    if (tenant) await cleanupTenantAccount(db, tenant);
    await db.end({ timeout: 5 });
    db = undefined;
  });

  it('migration 124 builds idx_jo_failed_created and idx_jo_completed_at valid, ready and exactly shaped', async () => {
    const failed = await fetchIndex('idx_jo_failed_created');
    expect(failed).toMatchObject({ indisvalid: true, indisready: true });
    expect(failed?.indexdef).toBe(
      "CREATE INDEX idx_jo_failed_created ON public.job_outbox USING btree (created_at DESC) INCLUDE (topic) WHERE (status = 'failed'::text)",
    );

    const completed = await fetchIndex('idx_jo_completed_at');
    expect(completed).toMatchObject({ indisvalid: true, indisready: true });
    expect(completed?.indexdef).toBe(
      "CREATE INDEX idx_jo_completed_at ON public.job_outbox USING btree (completed_at) WHERE (status = 'completed'::text)",
    );
  });

  it('the bounded outbox summary equals the WHERE-less whole-table count it replaced', async () => {
    await sql().begin('isolation level repeatable read', async (tx) => {
      const data = await getAdminJobsData(tx as unknown as postgresType.Sql, { limit: 50, offset: 0 });
      const [reference] = await tx<
        { pending: number; dispatching: number; dispatched: number; failed: number; completed_today: number }[]
      >`
        SELECT
          COUNT(CASE WHEN status = 'pending' THEN 1 END)::int AS pending,
          COUNT(CASE WHEN status = 'dispatching' THEN 1 END)::int AS dispatching,
          COUNT(CASE WHEN status = 'dispatched' THEN 1 END)::int AS dispatched,
          COUNT(CASE WHEN status = 'failed' THEN 1 END)::int AS failed,
          COUNT(CASE WHEN status = 'completed' AND completed_at >= CURRENT_DATE THEN 1 END)::int AS completed_today
        FROM job_outbox
      `;
      expect(data.outbox).toEqual({
        pending: reference!.pending,
        dispatching: reference!.dispatching,
        dispatched: reference!.dispatched,
        failed: reference!.failed,
        completedToday: reference!.completed_today,
      });
      // The fixtures are inside the numbers, not beside them.
      expect(data.outbox.failed).toBeGreaterThanOrEqual(1);
      expect(data.outbox.completedToday).toBeGreaterThanOrEqual(1);
      expect(data.failedTopics).toContain(FIXTURE_TOPIC);
    });
  });

  it('the bounded email-health read equals the WHERE-less whole-table read it replaced', async () => {
    await sql().begin('isolation level repeatable read', async (tx) => {
      const overview = await getAdminOverview(tx as unknown as postgresType.Sql);
      const [reference] = await tx<
        { sent_24h: number; delivered_24h: number; bounces_7d: number; hard_bounces_7d: number; complaints_7d: number }[]
      >`
        SELECT
          COUNT(*) FILTER (WHERE sent_at >= NOW() - INTERVAL '24 hours')::int AS sent_24h,
          COUNT(*) FILTER (WHERE delivered_at IS NOT NULL AND sent_at >= NOW() - INTERVAL '24 hours')::int AS delivered_24h,
          COUNT(*) FILTER (WHERE failure_reason LIKE 'bounced:%' AND failed_at >= NOW() - INTERVAL '7 days')::int AS bounces_7d,
          COUNT(*) FILTER (WHERE failure_reason LIKE 'bounced:hard:%' AND failed_at >= NOW() - INTERVAL '7 days')::int AS hard_bounces_7d,
          COUNT(*) FILTER (WHERE failure_reason = 'complained' AND failed_at >= NOW() - INTERVAL '7 days')::int AS complaints_7d
        FROM notification_deliveries
      `;
      const email = overview.systemHealth.emailHealth;
      expect({
        sent_24h: email.sent24h,
        delivered_24h: email.delivered24h,
        bounces_7d: email.bounces7d,
        hard_bounces_7d: email.hardBounces7d,
        complaints_7d: email.complaints7d,
      }).toEqual(reference);
      expect(email.hardBounces7d).toBeGreaterThanOrEqual(1);
      expect(email.sent24h).toBeGreaterThanOrEqual(1);
    });
  });

  it("getAdminJobsData's own summary, failed page, failed total and topic reads resolve to migration 124 indexes", async () => {
    // Capture the SQL the service ACTUALLY sends (postgres.js `debug` hook), so
    // this plans the shipped text rather than a copy of it that could drift.
    const captured: { query: string; params: unknown[] }[] = [];
    const recorder = postgres(assertLocalTestDatabaseUrl(testDatabaseUrl), {
      max: 1,
      prepare: false,
      debug: (_connection, query, params) => {
        captured.push({ query, params: [...params] });
      },
    });
    try {
      await getAdminJobsData(recorder, { limit: 50, offset: 0 });
    } finally {
      await recorder.end({ timeout: 5 });
    }
    // postgres.js also sends its own type-catalogue read on connect; keep the
    // service's four statements only.
    const reads = captured.filter((c) => c.query.includes('job_outbox'));
    expect(reads).toHaveLength(4);
    const [summary, page, total, topics] = reads;

    expect(await explainIndexes(summary!.query, summary!.params)).toEqual(
      expect.arrayContaining(['idx_jo_pending', 'idx_jo_recovery', 'idx_jo_failed_created', 'idx_jo_completed_at']),
    );
    expect(await explainIndexes(page!.query, page!.params)).toContain('idx_jo_failed_created');
    expect(await explainIndexes(total!.query, total!.params)).toContain('idx_jo_failed_created');
    expect(await explainIndexes(topics!.query, topics!.params)).toContain('idx_jo_failed_created');
  });
});
