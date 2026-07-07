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
  recordOutcome,
  recordStep,
  startOrGetActiveRun,
} from '../run-spine';

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
const testDatabaseUrl = process.env.TEST_DATABASE_POOL_URL;

// max: 2 — the concurrency tests intentionally run two transactions at once.
let db: postgresType.Sql | undefined;
let tenant: TenantSeed | undefined;

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

describeWithDb('run-spine writers against live Postgres', { timeout: 30_000 }, () => {
  beforeAll(async () => {
    db = postgres(testDatabaseUrl!, { max: 2, prepare: false });
    await db.unsafe(
      readFileSync(resolve(process.cwd(), 'supabase/migrations/071_agent_run_spine.sql'), 'utf-8'),
    );
    tenant = await seedTenantAccount(db, {
      userName: 'Run Spine Owner',
      accountDisplayName: 'Run Spine Account',
    });
  });

  afterAll(async () => {
    if (!db) return;
    if (tenant) {
      await sql()`DELETE FROM agent_outcomes WHERE account_id = ${tenant.accountId}::uuid`;
      // agent_run_steps cascade with their runs.
      await sql()`DELETE FROM agent_runs WHERE account_id = ${tenant.accountId}::uuid`;
      await cleanupTenantAccount(sql(), tenant);
    }
    await db.end({ timeout: 5 });
  });

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
});
