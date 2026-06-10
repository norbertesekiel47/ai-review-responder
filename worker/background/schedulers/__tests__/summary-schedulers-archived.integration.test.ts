// worker/background/schedulers/__tests__/summary-schedulers-archived.integration.test.ts
//
// True SQL-level companion to the textual pins in
// summary-report-schedulers.test.ts. The unit tests pin the candidate query
// TEXT (`b.archived_at IS NULL` ahead of the NOT EXISTS dedup); this test
// proves the query BEHAVES against real Postgres: an archived location on an
// active account must NOT receive a summary outbox row while its active
// sibling does.
//
// Exercises the REAL schedulers (WeeklySummaryScheduler /
// MonthlyImpactScheduler) by pointing the shared src/lib/db/server client at
// the test database before the scheduler modules load. `checkAndSchedule` is
// not exported, so this uses the same start/stop seam as the unit suite —
// `start*Scheduler()` runs one cycle immediately; the 1h default interval
// guarantees no second cycle inside the test. Only `Date` is faked (to land
// inside each scheduler's UTC dispatch window); timers and I/O stay real so
// the cycle runs against the live database.
//
// The candidate queries are account-global, so a run on a shared test DB may
// enqueue rows for OTHER due tenants too — every assertion and cleanup here is
// scoped to the two seeded business ids.
//
// Gated on a real test database (TEST_DATABASE_POOL_URL), like the repo's
// other live-DB integration tests (see
// worker/ingress/zernio/__tests__/zernio-fanout-archived.integration.test.ts);
// skips cleanly without one (e.g. in the no-DB CI test job). The database is
// expected to already have all migrations applied.

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import type postgresType from 'postgres';
import { randomUUID } from 'node:crypto';
import {
  cleanupTenantAccount,
  seedTenantAccount,
} from '../../../../src/lib/shared/__tests__/live-db-tenant';

const testDatabaseUrl = process.env.TEST_DATABASE_POOL_URL;
const RUN = Boolean(testDatabaseUrl);
const d = RUN ? describe : describe.skip;

// 2026-06-01 is BOTH a Monday and the 1st of the month — one seeded tenant
// serves both schedulers' dispatch windows (Mon 8–9 AM UTC / 1st 9–10 AM UTC).
const WEEKLY_WINDOW_TIME = '2026-06-01T08:30:00Z';
const MONTHLY_WINDOW_TIME = '2026-06-01T09:30:00Z';

const OUTBOX_TOPICS = ['weekly_summary', 'send_monthly_impact'] as const;
type OutboxTopic = (typeof OUTBOX_TOPICS)[number];

let db: postgresType.Sql | undefined;
let weeklyScheduler: { start: () => void; stop: () => void } | undefined;
let monthlyScheduler: { start: () => void; stop: () => void } | undefined;

const tenant = {
  userId: randomUUID(),
  accountId: randomUUID(),
  activeBusinessId: randomUUID(),
  archivedBusinessId: randomUUID(),
};
const ownerEmail = `summary-schedulers-archived-${tenant.accountId}@test.local`;

function sql(): postgresType.Sql {
  if (!db) throw new Error('summary-scheduler integration database was not initialized');
  return db;
}

async function outboxRowCount(topic: OutboxTopic, businessId: string): Promise<number> {
  const rows = await sql()<{ id: string }[]>`
    SELECT id FROM job_outbox
    WHERE topic = ${topic}
      AND aggregate_id = ${businessId}::uuid
  `;
  return rows.length;
}

/**
 * Waits (real timers — only Date is faked) until the scheduler cycle kicked
 * off by `start()` has enqueued the active business's outbox row. Once that
 * row exists the cycle's candidate SELECT has already run — and it either
 * included or excluded the archived sibling at that moment — so the negative
 * assertion that follows cannot race a late insert (the next cycle is a full
 * real-time interval away).
 */
async function waitForActiveOutboxRow(topic: OutboxTopic): Promise<void> {
  const timeoutMs = 15_000;
  const startedAt = performance.now();
  for (;;) {
    if ((await outboxRowCount(topic, tenant.activeBusinessId)) > 0) return;
    if (performance.now() - startedAt > timeoutMs) {
      throw new Error(`Timed out waiting for ${topic} outbox row for the active business`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function runSchedulerCycleAt(
  scheduler: { start: () => void; stop: () => void },
  windowTime: string,
  topic: OutboxTopic,
): Promise<void> {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(windowTime));
  try {
    scheduler.start();
    await waitForActiveOutboxRow(topic);
  } finally {
    scheduler.stop();
    vi.useRealTimers();
  }
}

d('Summary-report schedulers vs archived locations (live DB)', () => {
  beforeAll(async () => {
    // Point the shared db/server client at the test database BEFORE the
    // scheduler modules (and their transitive db/server import) are first
    // loaded — db/server reads DATABASE_POOL_URL at module-evaluation time.
    process.env.DATABASE_POOL_URL = testDatabaseUrl!;
    // Pin the interval explicitly: one immediate cycle per start(), no re-tick
    // within the test's lifetime.
    process.env.WEEKLY_SUMMARY_SCHEDULER_INTERVAL_MS = '3600000';
    process.env.MONTHLY_IMPACT_SCHEDULER_INTERVAL_MS = '3600000';

    const weeklyModule = await import('../WeeklySummaryScheduler');
    weeklyScheduler = {
      start: weeklyModule.startWeeklySummaryScheduler,
      stop: weeklyModule.stopWeeklySummaryScheduler,
    };
    const monthlyModule = await import('../MonthlyImpactScheduler');
    monthlyScheduler = {
      start: monthlyModule.startMonthlyImpactScheduler,
      stop: monthlyModule.stopMonthlyImpactScheduler,
    };

    db = postgres(testDatabaseUrl!, { max: 1, prepare: false });
    await seedTenantAccount(sql(), {
      userId: tenant.userId,
      accountId: tenant.accountId,
      ownerEmail,
      userName: 'Summary Scheduler Owner',
      accountDisplayName: 'Summary Scheduler Account',
      subscriptionStatus: 'active',
    });
    // Domain rows reference the committed user/account pair — no deferral
    // needed. Summary/impact enablement flags stay NULL (= enabled) and no
    // weekly_summaries / monthly_impact_emails sent rows exist, so both
    // businesses are "due"; only archived_at separates them.
    await sql()`
      INSERT INTO businesses (id, name, owner_name, owner_email, account_id, is_primary, display_label, subscription_status, archived_at)
      VALUES
        (${tenant.activeBusinessId}::uuid, 'Summary Active Location', 'Summary Scheduler Owner', ${ownerEmail}, ${tenant.accountId}::uuid, TRUE, 'Summary Active Location', 'active', NULL),
        (${tenant.archivedBusinessId}::uuid, 'Summary Archived Location', 'Summary Scheduler Owner', ${ownerEmail}, ${tenant.accountId}::uuid, FALSE, 'Summary Archived Location', 'active', NOW())
    `;
  });

  afterEach(() => {
    // Defensive: a failed wait must not leave a real interval ticking.
    weeklyScheduler?.stop();
    monthlyScheduler?.stop();
    vi.useRealTimers();
  });

  afterAll(async () => {
    if (db) {
      await sql()`
        DELETE FROM job_outbox
        WHERE topic IN ('weekly_summary', 'send_monthly_impact')
          AND aggregate_id IN (${tenant.activeBusinessId}::uuid, ${tenant.archivedBusinessId}::uuid)
      `;
      await sql()`
        DELETE FROM businesses
        WHERE id IN (${tenant.activeBusinessId}::uuid, ${tenant.archivedBusinessId}::uuid)
      `;
      await cleanupTenantAccount(sql(), tenant);
      await db.end({ timeout: 5 });
    }
    // Close the schedulers' shared db/server client too, or the vitest fork
    // can hang on its open sockets.
    if (RUN) {
      const { sql: serverSql } = await import('../../../../src/lib/db/server');
      await serverSql.end({ timeout: 5 });
    }
  });

  it('WeeklySummaryScheduler enqueues the active business and never the archived sibling', async () => {
    await runSchedulerCycleAt(weeklyScheduler!, WEEKLY_WINDOW_TIME, 'weekly_summary');

    expect(await outboxRowCount('weekly_summary', tenant.activeBusinessId)).toBe(1);
    expect(await outboxRowCount('weekly_summary', tenant.archivedBusinessId)).toBe(0);

    // The enqueued row targets the week that just ended (Monday 2026-05-25).
    const [row] = await sql()<{ week_start_date: string }[]>`
      SELECT payload->>'week_start_date' AS week_start_date
      FROM job_outbox
      WHERE topic = 'weekly_summary'
        AND aggregate_id = ${tenant.activeBusinessId}::uuid
    `;
    expect(row?.week_start_date).toBe('2026-05-25');
  });

  it('MonthlyImpactScheduler enqueues the active business and never the archived sibling', async () => {
    await runSchedulerCycleAt(monthlyScheduler!, MONTHLY_WINDOW_TIME, 'send_monthly_impact');

    expect(await outboxRowCount('send_monthly_impact', tenant.activeBusinessId)).toBe(1);
    expect(await outboxRowCount('send_monthly_impact', tenant.archivedBusinessId)).toBe(0);

    // The enqueued row targets the month that just ended (2026-05-01).
    const [row] = await sql()<{ month_start_date: string }[]>`
      SELECT payload->>'month_start_date' AS month_start_date
      FROM job_outbox
      WHERE topic = 'send_monthly_impact'
        AND aggregate_id = ${tenant.activeBusinessId}::uuid
    `;
    expect(row?.month_start_date).toBe('2026-05-01');
  });
});
