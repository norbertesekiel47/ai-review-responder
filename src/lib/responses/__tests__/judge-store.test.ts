import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockSql, sqlReturnQueue, sqlCalls, resetMockSql, mkTaggedResult } =
  await vi.hoisted(async () => {
    const helpers = await import('../../../../worker/__tests__/helpers/mock-sql');
    return { ...helpers.createMockSql(), mkTaggedResult: helpers.mkTaggedResult };
  });

import {
  findLatestRunIdForReview,
  insertJudgeVerdict,
  listUnjudgedAutoPosts,
} from '../judge-store';
import { PAST_DUE_EXTENSION_TIMESTAMP_PATTERN } from '@/lib/shared/past-due-recovery';

const verdictInput = {
  accountId: 'account-1',
  businessId: 'business-1',
  reviewId: 'review-1',
  responseId: 'response-1',
  agentRunId: null,
  verdict: 'pass' as const,
  reasons: [],
  rationale: 'Safe and appropriate.',
  model: 'gpt-4o-mini-2024-07-18',
  promptVersion: '2026-07-13.1',
};

describe('judge verdict store', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetMockSql();
  });

  it('reports a response-id conflict as not inserted', async () => {
    sqlReturnQueue.push(mkTaggedResult([]));

    const result = await insertJudgeVerdict(mockSql as never, verdictInput);

    expect(result).toEqual({ inserted: false });
    expect(sqlCalls[0]!.text).toContain('INSERT INTO judge_verdicts');
    expect(sqlCalls[0]!.text).toContain('ON CONFLICT (response_id) DO NOTHING');
    expect(sqlCalls[0]!.text).toContain('RETURNING id');
  });

  it('writes a UUIDv7 verdict row and JSONB reason categories', async () => {
    sqlReturnQueue.push(mkTaggedResult([{ id: 'verdict-1' }]));

    const result = await insertJudgeVerdict(mockSql as never, {
      ...verdictInput,
      reasons: ['brand_tone'],
    });

    expect(result).toEqual({ inserted: true });
    expect(sqlCalls[0]!.values[0]).toEqual(
      expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
    );
    expect(mockSql.json).toHaveBeenCalledWith(['brand_tone']);
  });

  it('returns the latest review-handler run regardless of status', async () => {
    sqlReturnQueue.push(mkTaggedResult([{ id: 'latest-run' }]));

    const runId = await findLatestRunIdForReview(mockSql as never, 'review-1');

    expect(runId).toBe('latest-run');
    expect(sqlCalls[0]!.text).toContain("kind = 'review_handler'");
    expect(sqlCalls[0]!.text).toContain("subject_type = 'review'");
    expect(sqlCalls[0]!.text).not.toContain("status = 'running'");
    expect(sqlCalls[0]!.text).toContain('ORDER BY started_at DESC');
    expect(sqlCalls[0]!.text).toContain('LIMIT 1');
    expect(sqlCalls[0]!.values).toEqual(['review-1']);
  });

  it('returns null when a review has no run', async () => {
    sqlReturnQueue.push(mkTaggedResult([]));

    await expect(findLatestRunIdForReview(mockSql as never, 'review-1')).resolves.toBeNull();
  });

  it('returns only eligible posted auto-policy replies with no verdict or in-flight judge job', async () => {
    const candidate = {
      response_id: 'response-1',
      business_id: 'business-1',
      account_id: 'account-1',
    };
    sqlReturnQueue.push(mkTaggedResult([candidate]));

    const rows = await listUnjudgedAutoPosts(mockSql as never, {
      lookbackHours: 24,
      limit: 50,
    });

    expect([...rows]).toEqual([candidate]);
    const query = sqlCalls[0]!;
    expect(query.text).toContain('FROM responses r');
    expect(query.text).toContain('JOIN businesses b ON b.id = r.business_id');
    expect(query.text).toContain('JOIN accounts a ON a.id = b.account_id');
    expect(query.text).toContain("r.status = 'posted'");
    expect(query.text).toContain("r.approval_method = 'auto_policy'");
    expect(query.text).toContain('r.posted_at >= NOW() - make_interval(hours => ?)');
    expect(query.text).toContain('a.subscription_status IN (?, ?)');
    const normalizedSql = query.text.replace(/\s+/g, ' ').trim();
    expect(normalizedSql).toContain(
      'AND NOT EXISTS ( SELECT 1 FROM judge_verdicts jv WHERE jv.response_id = r.id )',
    );
    expect(normalizedSql).toContain(
      "AND NOT EXISTS ( SELECT 1 FROM job_outbox jo WHERE jo.topic = ? AND jo.aggregate_id = r.id AND jo.status IN ('pending', 'dispatching', 'dispatched') )",
    );
    expect(query.text).toContain('ORDER BY r.posted_at ASC, r.id ASC');
    expect(query.text).toContain('LIMIT ?');
    expect(query.text).toContain('a.past_due_at > NOW() - make_interval');
    expect(query.text).toContain("a.flags->'past_due_extension'");
    expect(query.text).toContain("NOW() AT TIME ZONE 'UTC'");
    expect(query.text).toContain('substring');
    expect(query.text).not.toContain('pg_input_is_valid');
    expect(query.text).not.toContain('::timestamptz');
    const daysTypeCheck = query.text.indexOf(
      "jsonb_typeof(a.flags->'past_due_extension'->'days') = 'number'",
    );
    const daysCast = query.text.indexOf("->>'days')::numeric", daysTypeCheck);
    const lazyDaysBranch = query.text.indexOf('THEN CASE', daysTypeCheck);
    expect(daysTypeCheck).toBeGreaterThan(-1);
    expect(lazyDaysBranch).toBeGreaterThan(daysTypeCheck);
    expect(daysCast).toBeGreaterThan(lazyDaysBranch);
    expect(query.values).toEqual([
      24,
      'active',
      'trialing',
      'past_due',
      7,
      PAST_DUE_EXTENSION_TIMESTAMP_PATTERN,
      'judge_verdict',
      50,
    ]);
  });

  it.each([
    { lookbackHours: 0, limit: 50 },
    { lookbackHours: 25, limit: 50 },
    { lookbackHours: 1.5, limit: 50 },
    { lookbackHours: 24, limit: 0 },
    { lookbackHours: 24, limit: 51 },
    { lookbackHours: 24, limit: 1.5 },
  ])('rejects an unbounded scan before querying: %o', async (options) => {
    await expect(listUnjudgedAutoPosts(mockSql as never, options)).rejects.toThrow(RangeError);
    expect(sqlCalls).toHaveLength(0);
  });
});
