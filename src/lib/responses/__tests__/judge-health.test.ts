import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockSql, sqlReturnQueue, sqlCalls, resetMockSql, mkTaggedResult } =
  await vi.hoisted(async () => {
    const helpers = await import('../../../../worker/__tests__/helpers/mock-sql');
    return { ...helpers.createMockSql(), mkTaggedResult: helpers.mkTaggedResult };
  });

import { isJudgeHealthy, JUDGE_SWEEP_LIVENESS_LIMIT_SECONDS } from '../judge-health';

// A sweep heartbeat recorded `ageSeconds` ago. `last_cycle_at` is reporting-only
// — the probe thresholds on `age_seconds`, which Postgres computes — so the two
// need not agree here, and deliberately do not: a test that derived one from the
// other would pass even if the probe started trusting the JS clock.
const heartbeat = (ageSeconds: number) =>
  mkTaggedResult([{ last_cycle_at: new Date('2026-01-01T00:00:00Z'), age_seconds: ageSeconds }]);
const FRESH = () => heartbeat(30);

describe('isJudgeHealthy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetMockSql();
  });

  it('is healthy when the bounded eligible population has no stale unjudged row or errors', async () => {
    sqlReturnQueue.push(
      mkTaggedResult([{ has_stale_unjudged: false }]),
      mkTaggedResult([{ total_count: 0, error_count: 0 }]),
      FRESH(),
    );

    await expect(isJudgeHealthy(mockSql as never)).resolves.toBe(true);

    expect(sqlCalls).toHaveLength(3);
    expect(sqlCalls[0]!.text).toContain("r.status = 'posted'");
    expect(sqlCalls[0]!.text).toContain("r.approval_method = 'auto_policy'");
    expect(sqlCalls[0]!.text).toContain('a.subscription_status IN');
    expect(sqlCalls[0]!.values).toEqual(expect.arrayContaining([
      24, 60, 'active', 'trialing', 'past_due', 7, 'judge_verdict',
    ]));
    expect(sqlCalls[0]!.text).toContain('a.past_due_at > NOW() - make_interval');
    expect(sqlCalls[0]!.text).toContain("NOW() AT TIME ZONE 'UTC'");
    expect(sqlCalls[0]!.text).not.toContain('pg_input_is_valid');
    expect(sqlCalls[0]!.text).not.toContain('::timestamptz');
    expect(sqlCalls[0]!.values).not.toContain('cancelled');
    expect(sqlCalls[0]!.text).toContain('NOT EXISTS');
    // FIX-4 throughput semantics: a row is stale only when a judge_verdict
    // outbox row (ANY status — no status filter) has existed past the limit.
    expect(sqlCalls[0]!.text).toContain('FROM job_outbox jo');
    expect(sqlCalls[0]!.text).toContain('jo.created_at < NOW() - make_interval');
    expect(sqlCalls[0]!.text).not.toContain('jo.status');
    // FIX-5: budget-decision error verdicts are excluded from error density.
    expect(sqlCalls[1]!.text).toContain("FILTER (");
    expect(sqlCalls[1]!.text).toContain("WHERE verdict = 'error'");
    expect(sqlCalls[1]!.text).toContain('NOT COALESCE(reasons @>');
    expect(sqlCalls[1]!.values).toEqual(expect.arrayContaining([['budget_exceeded'], 60]));
    expect(sqlCalls[1]!.text).toContain('created_at >= NOW() - make_interval');
    // #949 arm 3. The age is computed DB-side, never from the worker clock.
    expect(sqlCalls[2]!.text).toContain('FROM poller_heartbeats');
    expect(sqlCalls[2]!.text).toContain('EXTRACT(EPOCH FROM (NOW() - last_cycle_at))');
    expect(sqlCalls[2]!.values).toEqual(['judge_sweep']);
  });

  it('is unhealthy when an enqueued eligible auto-post remains unjudged past the stale boundary', async () => {
    sqlReturnQueue.push(
      mkTaggedResult([{ has_stale_unjudged: true }]),
      mkTaggedResult([{ total_count: 20, error_count: 0 }]),
    );

    await expect(isJudgeHealthy(mockSql as never)).resolves.toBe(false);
  });

  it('keeps a single poison error healthy because density requires three errors', async () => {
    sqlReturnQueue.push(
      mkTaggedResult([{ has_stale_unjudged: false }]),
      mkTaggedResult([{ total_count: 1, error_count: 1 }]),
      FRESH(),
    );

    await expect(isJudgeHealthy(mockSql as never)).resolves.toBe(true);
  });

  it.each([
    { total: 6, errors: 3 },
    { total: 3, errors: 3 },
  ])('is unhealthy at or above the 50% error-density threshold ($errors/$total)', async ({ total, errors }) => {
    sqlReturnQueue.push(
      mkTaggedResult([{ has_stale_unjudged: false }]),
      mkTaggedResult([{ total_count: total, error_count: errors }]),
    );

    await expect(isJudgeHealthy(mockSql as never)).resolves.toBe(false);
  });

  it('is healthy below the error-density share even with three errors', async () => {
    sqlReturnQueue.push(
      mkTaggedResult([{ has_stale_unjudged: false }]),
      mkTaggedResult([{ total_count: 7, error_count: 3 }]),
      FRESH(),
    );

    await expect(isJudgeHealthy(mockSql as never)).resolves.toBe(true);
  });

  // ── #949: the sweep-liveness arm ──────────────────────────────────────────
  // These are the cases the other two arms are STRUCTURALLY unable to answer.
  // Arm 1's staleness predicate requires a job_outbox row that the sweep itself
  // writes, and arm 2 requires verdicts the sweep's work produces, so both are
  // silent exactly when the sweep is dead. Every case below therefore feeds
  // CLEAN signals to arms 1 and 2 — a `false` result can only come from arm 3.
  it('is unhealthy when the sweep heartbeat is older than the liveness limit', async () => {
    sqlReturnQueue.push(
      mkTaggedResult([{ has_stale_unjudged: false }]),
      mkTaggedResult([{ total_count: 0, error_count: 0 }]),
      heartbeat(JUDGE_SWEEP_LIVENESS_LIMIT_SECONDS + 1),
    );

    await expect(isJudgeHealthy(mockSql as never)).resolves.toBe(false);
  });

  it('is unhealthy when the sweep has NEVER recorded a cycle', async () => {
    sqlReturnQueue.push(
      mkTaggedResult([{ has_stale_unjudged: false }]),
      mkTaggedResult([{ total_count: 0, error_count: 0 }]),
      mkTaggedResult([]),
    );

    // Fail CLOSED on a missing row. A freshly migrated database and a sweep that
    // has never once run are indistinguishable here, and treating either as
    // healthy is exactly the #949 hole.
    await expect(isJudgeHealthy(mockSql as never)).resolves.toBe(false);
  });

  it('is unhealthy AT the liveness limit, healthy one second under it', async () => {
    sqlReturnQueue.push(
      mkTaggedResult([{ has_stale_unjudged: false }]),
      mkTaggedResult([{ total_count: 0, error_count: 0 }]),
      heartbeat(JUDGE_SWEEP_LIVENESS_LIMIT_SECONDS),
    );
    await expect(isJudgeHealthy(mockSql as never)).resolves.toBe(false);

    resetMockSql();
    sqlReturnQueue.push(
      mkTaggedResult([{ has_stale_unjudged: false }]),
      mkTaggedResult([{ total_count: 0, error_count: 0 }]),
      heartbeat(JUDGE_SWEEP_LIVENESS_LIMIT_SECONDS - 1),
    );
    await expect(isJudgeHealthy(mockSql as never)).resolves.toBe(true);
  });

  it('skips the heartbeat query once an earlier arm has already answered false', async () => {
    sqlReturnQueue.push(
      mkTaggedResult([{ has_stale_unjudged: true }]),
      mkTaggedResult([{ total_count: 0, error_count: 0 }]),
    );

    await expect(isJudgeHealthy(mockSql as never)).resolves.toBe(false);
    // All three arms veto, so the answer is the same either way; not issuing a
    // third query when it cannot change the outcome is the only reason to care.
    expect(sqlCalls).toHaveLength(2);
  });

  it('propagates a health query failure', async () => {
    const queryError = new Error('database unavailable');
    const rejected = Promise.reject(queryError);
    rejected.catch(() => {});
    sqlReturnQueue.push(rejected);

    await expect(isJudgeHealthy(mockSql as never)).rejects.toBe(queryError);
    expect(sqlCalls).toHaveLength(1);
  });
});
