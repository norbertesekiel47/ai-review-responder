import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockSql, sqlReturnQueue, sqlCalls, resetMockSql, mkTaggedResult } =
  await vi.hoisted(async () => {
    const helpers = await import('../../../../worker/__tests__/helpers/mock-sql');
    return { ...helpers.createMockSql(), mkTaggedResult: helpers.mkTaggedResult };
  });

import { isJudgeHealthy } from '../judge-health';

describe('isJudgeHealthy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetMockSql();
  });

  it('is healthy when the bounded eligible population has no stale unjudged row or errors', async () => {
    sqlReturnQueue.push(
      mkTaggedResult([{ has_stale_unjudged: false }]),
      mkTaggedResult([{ total_count: 0, error_count: 0 }]),
    );

    await expect(isJudgeHealthy(mockSql as never)).resolves.toBe(true);

    expect(sqlCalls).toHaveLength(2);
    expect(sqlCalls[0]!.text).toContain("r.status = 'posted'");
    expect(sqlCalls[0]!.text).toContain("r.approval_method = 'auto_policy'");
    expect(sqlCalls[0]!.text).toContain('a.subscription_status IN');
    expect(sqlCalls[0]!.values).toEqual(expect.arrayContaining([
      24, 60, 'active', 'trialing', 'past_due', 7,
    ]));
    expect(sqlCalls[0]!.text).toContain('a.past_due_at > NOW() - make_interval');
    expect(sqlCalls[0]!.text).toContain("NOW() AT TIME ZONE 'UTC'");
    expect(sqlCalls[0]!.text).not.toContain('pg_input_is_valid');
    expect(sqlCalls[0]!.text).not.toContain('::timestamptz');
    expect(sqlCalls[0]!.values).not.toContain('cancelled');
    expect(sqlCalls[0]!.text).toContain('NOT EXISTS');
    expect(sqlCalls[1]!.text).toContain("FILTER (WHERE verdict = 'error')");
    expect(sqlCalls[1]!.text).toContain('created_at >= NOW() - make_interval');
  });

  it('is unhealthy when an eligible auto-post remains unjudged past the stale boundary', async () => {
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
    );

    await expect(isJudgeHealthy(mockSql as never)).resolves.toBe(true);
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
