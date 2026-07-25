import { afterAll, beforeAll, expect, it } from 'vitest';
import postgres from 'postgres';
import type postgresType from 'postgres';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describeWithDb } from '@/__tests__/helpers/describe-with-db';
import {
  cleanupTenantAccount,
  seedTenantAccount,
  type TenantSeed,
} from '@/lib/shared/__tests__/live-db-tenant';
import {
  completeRun,
  recordCompletedChildRuns,
  recordOutcome,
  recordStep,
  startOrGetActiveRun,
} from '../run-spine';
import { commitWeeklyInsightsDigest } from '../../../../worker/jobs/WeeklySummaryWorker';

// Real-schema behavioral suite for the run-spine writers. The unit suite only
// asserts SQL *text*, and SQL-text tests have shipped broken SQL before
// (staging dry-run defect D3 — see approval-audit-log-scrub.integration.test.ts).
// This drives the production writers against live Postgres: ON CONFLICT
// arbiter recognition, the post-lock step-index serialization, outcome replay
// dedup, and the terminal-transition semantics all execute for real.
//
// Gated on TEST_DATABASE_POOL_URL (skips cleanly without one), like the repo's
// other integration tests. Those expect all migrations already applied — but
// migration 071 is born on this branch, so no shared test DB can have it yet;
// beforeAll applies the (fully idempotent) migration file, which becomes a
// no-op everywhere once 071 ships.
function localTestDatabaseUrl(): string | undefined {
  if (process.env.TEST_DATABASE_POOL_URL) return process.env.TEST_DATABASE_POOL_URL;
  try {
    const raw = readFileSync(resolve(process.cwd(), '.env.local'), 'utf8');
    const line = raw.split('\n').find((candidate) =>
      /^\s*TEST_DATABASE_POOL_URL\s*=/.test(candidate),
    );
    return line
      ?.replace(/^\s*TEST_DATABASE_POOL_URL\s*=\s*/, '')
      .trim()
      .replace(/^["']|["']$/g, '');
  } catch {
    return undefined;
  }
}

const testDatabaseUrl = localTestDatabaseUrl();
// verify-gate runs changed integration files in separate processes against one DB.
// Keep this feature's schema setup and large fixture lifecycles from overlapping.
const FEATURE_543_DATABASE_LOCK_KEY = 'repworth_feature_543_integration';

// max: 2 — the concurrency tests intentionally run two transactions at once.
let db: postgresType.Sql | undefined;
let featureDatabaseLock: postgresType.Sql | undefined;
let tenant: TenantSeed | undefined;
const solicitationBusinessId = randomUUID();

function assertLocalTestDatabaseUrl(databaseUrl: string): string {
  const parsed = new URL(databaseUrl);
  if (
    (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') ||
    (parsed.hostname !== 'localhost' && parsed.hostname !== '127.0.0.1')
  ) {
    throw new Error('run-spine integration requires a local test database');
  }
  return databaseUrl;
}

function sql(): postgresType.Sql {
  if (!db) throw new Error('run-spine integration database was not initialized');
  return db;
}

function accountId(): string {
  if (!tenant) throw new Error('run-spine integration tenant was not seeded');
  return tenant.accountId;
}

function startInput(subjectId: string) {
  return {
    kind: 'review_handler',
    subjectType: 'review',
    subjectId,
    accountId: accountId(),
    businessId: null,
  } as const;
}

async function startRun(subjectId: string): Promise<string> {
  const { runId } = await sql().begin((tx) => startOrGetActiveRun(tx, startInput(subjectId)));
  return runId;
}

async function releaseFeatureDatabaseLock(): Promise<void> {
  if (!featureDatabaseLock) return;
  const lock = featureDatabaseLock;
  featureDatabaseLock = undefined;
  try {
    await lock`
      SELECT pg_advisory_unlock(hashtext(${FEATURE_543_DATABASE_LOCK_KEY}))
    `;
  } finally {
    await lock.end({ timeout: 5 });
  }
}

describeWithDb(
  'run-spine writers against live Postgres',
  { enabled: Boolean(testDatabaseUrl), timeout: 30_000 },
  () => {
  beforeAll(async () => {
    const databaseUrl = assertLocalTestDatabaseUrl(testDatabaseUrl!);
    featureDatabaseLock = postgres(databaseUrl, { max: 1, prepare: false });
    await featureDatabaseLock`
      SELECT pg_advisory_lock(hashtext(${FEATURE_543_DATABASE_LOCK_KEY}))
    `;
    db = postgres(databaseUrl, { max: 2, prepare: false });
    await db.unsafe(
      readFileSync(resolve(process.cwd(), 'supabase/migrations/071_agent_run_spine.sql'), 'utf-8'),
    );
    await db.unsafe(
      readFileSync(
        resolve(process.cwd(), 'supabase/migrations/088_solicitation_batch_executor.sql'),
        'utf-8',
      ),
    );
    tenant = await seedTenantAccount(db, {
      userName: 'Run Spine Owner',
      accountDisplayName: 'Run Spine Account',
    });
    await db`
      INSERT INTO businesses (
        id, name, owner_name, owner_email, account_id, subscription_status
      ) VALUES (
        ${solicitationBusinessId}::uuid,
        'Solicitation Run Spine',
        'Run Spine Owner',
        ${tenant.ownerEmail},
        ${tenant.accountId}::uuid,
        'active'
      )
    `;
  }, 120_000);

  afterAll(async () => {
    try {
      if (db && tenant) {
        await sql()`DELETE FROM agent_outcomes WHERE account_id = ${tenant.accountId}::uuid`;
        // agent_run_steps cascade with their runs.
        await sql()`DELETE FROM agent_runs WHERE account_id = ${tenant.accountId}::uuid`;
        await sql()`DELETE FROM businesses WHERE id = ${solicitationBusinessId}::uuid`;
        await cleanupTenantAccount(sql(), tenant);
      }
    } finally {
      try {
        if (db) await db.end({ timeout: 5 });
      } finally {
        await releaseFeatureDatabaseLock();
      }
    }
  }, 120_000);

  it('two concurrent startOrGetActiveRun calls converge on one run', async () => {
    const subjectId = randomUUID();
    const [first, second] = await Promise.all([
      sql().begin((tx) => startOrGetActiveRun(tx, startInput(subjectId))),
      sql().begin((tx) => startOrGetActiveRun(tx, startInput(subjectId))),
    ]);

    expect([first.created, second.created].filter(Boolean)).toHaveLength(1);
    expect(first.runId).toBe(second.runId);

    const rows = await sql()<{ count: string }[]>`
      SELECT COUNT(*) AS count FROM agent_runs
      WHERE subject_type = 'review' AND subject_id = ${subjectId}
    `;
    expect(Number(rows[0]!.count)).toBe(1);
  });

  it('sequential and concurrent recordStep calls yield gapless unique step indexes', async () => {
    const runId = await startRun(randomUUID());
    const responseId = randomUUID();

    await sql().begin((tx) => recordStep(tx, { runId, stepKey: 'review_ingested' }));
    await sql().begin((tx) =>
      recordStep(tx, {
        runId,
        stepKey: 'draft_generated',
        detail: { response_id: responseId, version: 1 },
        latencyMs: 42,
      }),
    );
    await sql().begin((tx) => recordStep(tx, { runId, stepKey: 'moderation_checked' }));

    const sequential = await sql()<
      { step_index: number; step_key: string; attributed_agent: string; detail: unknown }[]
    >`
      SELECT step_index, step_key, attributed_agent, detail
      FROM agent_run_steps WHERE agent_run_id = ${runId} ORDER BY step_index
    `;
    expect(sequential.map((row) => row.step_index)).toEqual([1, 2, 3]);
    expect(sequential.map((row) => row.step_key)).toEqual([
      'review_ingested', 'draft_generated', 'moderation_checked',
    ]);
    expect(sequential.map((row) => row.attributed_agent)).toEqual(['system', 'reply', 'system']);
    const rawDetail = sequential[1]!.detail;
    const detail = typeof rawDetail === 'string' ? JSON.parse(rawDetail) : rawDetail;
    expect(detail).toEqual({ response_id: responseId, version: 1 });

    // Two appenders at once: the own-statement run-row lock must serialize
    // them onto distinct indexes instead of throwing 23505 (review Fix 1).
    await Promise.all([
      sql().begin((tx) => recordStep(tx, { runId, stepKey: 'policy_gate' })),
      sql().begin((tx) => recordStep(tx, { runId, stepKey: 'owner_notified' })),
    ]);

    const after = await sql()<{ step_index: number }[]>`
      SELECT step_index FROM agent_run_steps WHERE agent_run_id = ${runId} ORDER BY step_index
    `;
    expect(after.map((row) => row.step_index)).toEqual([1, 2, 3, 4, 5]);
  });

  it('accepts a non-UUID correlation id (poller/ingest lanes pass logging strings)', async () => {
    // Live callers pass free-form correlation strings — the poller lane passes
    // `zernio-poll:<review-uuid>` and the ingest lane passes the provider event
    // id (TEXT). correlation_id must be TEXT: a UUID column aborts the WHOLE
    // ingest transaction with 22P02 on these inputs.
    const subjectId = randomUUID();
    const correlationId = `zernio-poll:${randomUUID()}`;

    const { runId, created } = await sql().begin((tx) =>
      startOrGetActiveRun(tx, { ...startInput(subjectId), correlationId }),
    );
    expect(created).toBe(true);

    const [row] = await sql()<{ correlation_id: string | null }[]>`
      SELECT correlation_id FROM agent_runs WHERE id = ${runId}
    `;
    expect(row!.correlation_id).toBe(correlationId);
  });

  it('replayed recordOutcome for the same (run, kind) stays one row', async () => {
    const runId = await startRun(randomUUID());
    const outcome = {
      runId,
      accountId: accountId(),
      businessId: null,
      attributedAgent: 'reply',
      outcomeKind: 'reply_posted',
    } as const;

    await sql().begin((tx) => recordOutcome(tx, outcome));
    await sql().begin((tx) => recordOutcome(tx, outcome)); // BullMQ-retry replay

    const rows = await sql()<{ count: string }[]>`
      SELECT COUNT(*) AS count FROM agent_outcomes
      WHERE agent_run_id = ${runId} AND outcome_kind = 'reply_posted'
    `;
    expect(Number(rows[0]!.count)).toBe(1);
  });

  it('persists Solicitation parent linkage and completed children against migration 088', async () => {
    const batchId = randomUUID();
    const askId = randomUUID();
    const childRunId = randomUUID();

    const { runId: parentRunId } = await sql().begin((tx) =>
      startOrGetActiveRun(tx, {
        kind: 'solicitation_batch',
        subjectType: 'solicitation_batch',
        subjectId: batchId,
        accountId: accountId(),
        businessId: solicitationBusinessId,
      }),
    );

    await sql().begin((tx) =>
      recordCompletedChildRuns(tx, {
        accountId: accountId(),
        businessId: solicitationBusinessId,
        parentRunId,
        children: [{
          runId: childRunId,
          askId,
          decision: 'withhold',
          withheldReason: 'stale_visit',
        }],
      }),
    );

    const [child] = await sql()<{
      parent_run_id: string | null;
      kind: string;
      subject_type: string;
      subject_id: string;
      status: string;
      ended_at: Date | null;
    }[]>`
      SELECT parent_run_id, kind, subject_type, subject_id, status, ended_at
      FROM agent_runs
      WHERE id = ${childRunId}::uuid
    `;
    expect(child).toMatchObject({
      parent_run_id: parentRunId,
      kind: 'solicitation_ask',
      subject_type: 'solicitation_ask',
      subject_id: askId,
      status: 'completed',
    });
    expect(child?.ended_at).not.toBeNull();

    const steps = await sql()<{
      step_index: number;
      step_key: string;
      attributed_agent: string;
      detail: unknown;
    }[]>`
      SELECT step_index, step_key, attributed_agent, detail
      FROM agent_run_steps
      WHERE agent_run_id = ${childRunId}::uuid
    `;
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({
      step_index: 1,
      step_key: 'ask_evaluated',
      attributed_agent: 'solicitation',
    });
    const rawDetail = steps[0]!.detail;
    const detail = typeof rawDetail === 'string' ? JSON.parse(rawDetail) : rawDetail;
    expect(detail).toEqual({
      ask_id: askId,
      decision: 'withhold',
      withheld_reason: 'stale_visit',
    });
  });

  it('completeRun transitions once, no-ops on replay, throws on a missing run', async () => {
    const runId = await startRun(randomUUID());

    await sql().begin((tx) => completeRun(tx, runId, 'completed'));

    const [completed] = await sql()<
      { status: string; ended_at: Date | null; error: unknown }[]
    >`SELECT status, ended_at, error FROM agent_runs WHERE id = ${runId}`;
    // agent_runs_terminal_consistency: terminal status ⇔ ended_at stamped.
    expect(completed!.status).toBe('completed');
    expect(completed!.ended_at).not.toBeNull();
    expect(completed!.error).toBeNull();

    // Replay (even with a different status + error payload) is a no-op.
    await sql().begin((tx) => completeRun(tx, runId, 'failed', { reason: 'replay' }));
    const [afterReplay] = await sql()<{ status: string; error: unknown }[]>`
      SELECT status, error FROM agent_runs WHERE id = ${runId}
    `;
    expect(afterReplay!.status).toBe('completed');
    expect(afterReplay!.error).toBeNull();

    await expect(
      sql().begin((tx) => completeRun(tx, randomUUID(), 'completed')),
    ).rejects.toThrow(/run not found/i);
  });

  it('commits separate weekly_insights runs per business and replay adds no spine rows', async () => {
    const firstBusinessId = randomUUID();
    const secondBusinessId = randomUUID();
    const weekStartDate = '2026-07-06';
    const subjectId = `${accountId()}_${weekStartDate}`;

    await sql()`
      INSERT INTO businesses (
        id, name, owner_name, owner_email, account_id, subscription_status
      ) VALUES
      (
        ${firstBusinessId}::uuid, 'Weekly Insights One', 'Run Spine Owner',
        ${tenant!.ownerEmail}, ${accountId()}::uuid, 'active'
      ),
      (
        ${secondBusinessId}::uuid, 'Weekly Insights Two', 'Run Spine Owner',
        ${tenant!.ownerEmail}, ${accountId()}::uuid, 'active'
      )
    `;
    await sql()`
      INSERT INTO weekly_summaries (
        id, business_id, week_start_date, total_reviews, total_responded
      ) VALUES
      (${randomUUID()}::uuid, ${firstBusinessId}::uuid, ${weekStartDate}::date, 3, 2),
      (${randomUUID()}::uuid, ${secondBusinessId}::uuid, ${weekStartDate}::date, 5, 5)
    `;

    try {
      const committed = await Promise.all([
        commitWeeklyInsightsDigest(sql(), {
          accountId: accountId(),
          businessId: firstBusinessId,
          weekStartDate,
          correlationId: 'weekly:first',
        }),
        commitWeeklyInsightsDigest(sql(), {
          accountId: accountId(),
          businessId: secondBusinessId,
          weekStartDate,
          correlationId: 'weekly:second',
        }),
      ]);
      expect(committed).toEqual([true, true]);
      await expect(commitWeeklyInsightsDigest(sql(), {
        accountId: accountId(),
        businessId: firstBusinessId,
        weekStartDate,
        correlationId: 'weekly:first:replay',
      })).resolves.toBe(false);

      const runs = await sql()<{
        id: string;
        business_id: string;
        subject_id: string;
        status: string;
        ended_at: Date | null;
      }[]>`
        SELECT id, business_id, subject_id, status, ended_at
        FROM agent_runs
        WHERE account_id = ${accountId()}::uuid
          AND kind = 'weekly_insights'
          AND subject_type = 'account_week'
          AND subject_id = ${subjectId}
        ORDER BY business_id
      `;
      expect(runs).toHaveLength(2);
      expect(runs.map((row) => row.business_id).sort()).toEqual(
        [firstBusinessId, secondBusinessId].sort(),
      );
      expect(runs.every((row) => row.status === 'completed' && row.ended_at !== null)).toBe(true);

      const steps = await sql()<{
        attributed_agent: string;
        step_key: string;
        status: string;
      }[]>`
        SELECT s.attributed_agent, s.step_key, s.status
        FROM agent_run_steps s
        JOIN agent_runs r ON r.id = s.agent_run_id
        WHERE r.subject_id = ${subjectId}
        ORDER BY r.business_id
      `;
      expect(steps).toEqual([
        { attributed_agent: 'insights', step_key: 'digest_sent', status: 'completed' },
        { attributed_agent: 'insights', step_key: 'digest_sent', status: 'completed' },
      ]);

      const outcomes = await sql()<{
        attributed_agent: string;
        outcome_kind: string;
      }[]>`
        SELECT o.attributed_agent, o.outcome_kind
        FROM agent_outcomes o
        JOIN agent_runs r ON r.id = o.agent_run_id
        WHERE r.subject_id = ${subjectId}
        ORDER BY r.business_id
      `;
      expect(outcomes).toEqual([
        { attributed_agent: 'insights', outcome_kind: 'digest_sent' },
        { attributed_agent: 'insights', outcome_kind: 'digest_sent' },
      ]);

      const [sent] = await sql()<{ count: string }[]>`
        SELECT COUNT(*) AS count
        FROM weekly_summaries
        WHERE business_id IN (${firstBusinessId}::uuid, ${secondBusinessId}::uuid)
          AND week_start_date = ${weekStartDate}::date
          AND sent_at IS NOT NULL
      `;
      expect(Number(sent!.count)).toBe(2);
    } finally {
      await sql()`DELETE FROM agent_runs WHERE business_id IN (
        ${firstBusinessId}::uuid, ${secondBusinessId}::uuid
      )`;
      await sql()`DELETE FROM businesses WHERE id IN (
        ${firstBusinessId}::uuid, ${secondBusinessId}::uuid
      )`;
    }
  });
  },
);
