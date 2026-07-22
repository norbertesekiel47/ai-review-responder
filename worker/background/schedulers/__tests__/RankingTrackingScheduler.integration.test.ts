// worker/background/schedulers/__tests__/RankingTrackingScheduler.integration.test.ts
//
// Behavioral, DB-level coverage of the COLLAPSED RankingTrackingScheduler's
// OUTPUT (the mocked unit suite only pins statement shape + gating). Drives the
// REAL exported `runRankingCheck()` against Postgres and proves the merged
// set-based INSERT…SELECT:
//   (a) enqueues exactly one track_ranking outbox row per eligible business,
//       with payload keys business_id / google_place_id / run_date /
//       correlation_id and the right value types, and DISTINCT correlation_id
//       across rows (each row gets its own gen_random_uuid());
//   (b) is idempotent within a period — a second cycle enqueues 0 more (the
//       in-flight NOT EXISTS pre-filter + ON CONFLICT DO NOTHING).
//
// The candidate scan is account-global, so a run on a shared test DB may enqueue
// rows for OTHER due tenants too — every assertion and cleanup here is scoped to
// the two seeded business ids.
//
// Gated on TEST_DATABASE_POOL_URL like the repo's other live-DB integration
// tests (see summary-schedulers-archived.integration.test.ts); skips cleanly
// without one. The database is expected to already have all migrations applied.

import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import type postgresType from 'postgres';
import { randomUUID } from 'node:crypto';
import {
  cleanupTenantAccount,
  seedTenantAccount,
} from '../../../../src/lib/shared/__tests__/live-db-tenant';
import { describeWithDb } from '../../../../src/__tests__/helpers/describe-with-db';

const testDatabaseUrl = process.env.TEST_DATABASE_POOL_URL;

// 2026-01-11 is a Sunday in ISO week 2 (even); 22:05 UTC is inside the ranking
// dispatch window (Sunday, hour 22, even week).
const RANKING_WINDOW_TIME = '2026-01-11T22:05:00Z';
const EXPECTED_RUN_DATE = '2026-01-11';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

let db: postgresType.Sql | undefined;
let runRankingCheck: (() => Promise<void>) | undefined;

// Two independent tenants, each with one eligible business.
const tenants = [
  { userId: randomUUID(), accountId: randomUUID(), businessId: randomUUID() },
  { userId: randomUUID(), accountId: randomUUID(), businessId: randomUUID() },
];
const businessIds = tenants.map((t) => t.businessId);

function sql(): postgresType.Sql {
  if (!db) throw new Error('ranking-scheduler integration database was not initialized');
  return db;
}

interface RankingOutboxRow {
  aggregate_id: string;
  business_id: string;
  google_place_id: string;
  run_date: string;
  correlation_id: string;
}

async function seededRankingRows(): Promise<RankingOutboxRow[]> {
  return sql()<RankingOutboxRow[]>`
    SELECT
      aggregate_id::text AS aggregate_id,
      payload->>'business_id' AS business_id,
      payload->>'google_place_id' AS google_place_id,
      payload->>'run_date' AS run_date,
      payload->>'correlation_id' AS correlation_id
    FROM job_outbox
    WHERE topic = 'track_ranking'
      AND aggregate_id = ANY(${businessIds}::uuid[])
    ORDER BY aggregate_id
  `;
}

async function runCycleAt(windowTime: string): Promise<void> {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(windowTime));
  try {
    await runRankingCheck!();
  } finally {
    vi.useRealTimers();
  }
}

describeWithDb('RankingTrackingScheduler set-based enqueue (live DB)', () => {
  beforeAll(async () => {
    // Point the shared db/server client at the test DB BEFORE the scheduler
    // module (and its transitive db/server import) is first loaded.
    process.env.DATABASE_POOL_URL = testDatabaseUrl!;
    process.env.RANKING_TRACKING_ENABLED = 'true';
    process.env.MOCK_EXTERNAL_APIS = 'false';

    const mod = await import('../RankingTrackingScheduler');
    runRankingCheck = mod.runRankingCheck;

    db = postgres(testDatabaseUrl!, { max: 1, prepare: false });

    for (const [index, tenant] of tenants.entries()) {
      await seedTenantAccount(sql(), {
        userId: tenant.userId,
        accountId: tenant.accountId,
        ownerEmail: `ranking-scheduler-${tenant.accountId}@test.local`,
        userName: 'Ranking Scheduler Owner',
        accountDisplayName: 'Ranking Scheduler Account',
        subscriptionStatus: 'active',
      });
      await sql()`
        INSERT INTO businesses (
          id, name, owner_name, owner_email, account_id, is_primary, display_label,
          subscription_status, place_id_verified, google_place_id, tracked_keywords,
          google_place_lat, google_place_lng
        )
        VALUES (
          ${tenant.businessId}::uuid, 'Ranking Location', 'Ranking Scheduler Owner',
          ${`ranking-scheduler-${tenant.accountId}@test.local`}, ${tenant.accountId}::uuid,
          TRUE, 'Ranking Location', 'active', TRUE, ${`ChIJ_ranking_place_${index}`},
          ${sql().json(['coffee shop'])}, 40.7128, -74.0060
        )
      `;
    }
  });

  afterAll(async () => {
    if (db) {
      await sql()`
        DELETE FROM job_outbox
        WHERE topic = 'track_ranking' AND aggregate_id = ANY(${businessIds}::uuid[])
      `;
      await sql()`DELETE FROM businesses WHERE id = ANY(${businessIds}::uuid[])`;
      for (const tenant of tenants) {
        await cleanupTenantAccount(sql(), tenant);
      }
      await db.end({ timeout: 5 });
    }
    // Close the scheduler's shared db/server client too, or the vitest fork can
    // hang on its open sockets.
    const { sql: serverSql } = await import('../../../../src/lib/db/server');
    await serverSql.end({ timeout: 5 });
  });

  it('enqueues one well-formed track_ranking row per eligible business, correlation_ids distinct', async () => {
    await runCycleAt(RANKING_WINDOW_TIME);

    const rows = await seededRankingRows();
    expect(rows).toHaveLength(2);

    for (const row of rows) {
      // Payload keys present with the right value types.
      expect(row.business_id).toBe(row.aggregate_id);
      expect(businessIds).toContain(row.business_id);
      expect(row.google_place_id).toMatch(/^ChIJ_ranking_place_[01]$/);
      expect(row.run_date).toBe(EXPECTED_RUN_DATE);
      expect(row.correlation_id).toMatch(UUID_RE);
    }

    // Each row gets its OWN gen_random_uuid() correlation_id.
    const correlationIds = new Set(rows.map((r) => r.correlation_id));
    expect(correlationIds.size).toBe(2);
  });

  it('is idempotent within a period — a second cycle enqueues 0 more', async () => {
    await runCycleAt(RANKING_WINDOW_TIME);

    const rows = await seededRankingRows();
    // Still exactly one row per seeded business — in-flight NOT EXISTS +
    // ON CONFLICT DO NOTHING absorbed the second cycle.
    expect(rows).toHaveLength(2);
  });
});
