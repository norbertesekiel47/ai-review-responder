import type { Job } from 'bullmq';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockSql, sqlReturnQueue, sqlCalls, resetMockSql, mkTaggedResult } =
  await vi.hoisted(async () => {
    const helpers = await import('../../../__tests__/helpers/mock-sql');
    return { ...helpers.createMockSql(), mkTaggedResult: helpers.mkTaggedResult };
  });

import type { JudgeVerdictPayload } from '@/lib/shared/worker-types';
import { handleJudgeFailed } from '../failed-hook';

function failedJob(attemptsMade: number, failedReason?: string): Job<JudgeVerdictPayload> {
  return {
    id: 'bull-job-1',
    attemptsMade,
    failedReason,
    opts: { attempts: 3 },
    data: {
      response_id: 'response-1',
      business_id: 'business-1',
      account_id: 'account-1',
      outbox_id: 'outbox-1',
      outbox_attempt: 2,
    },
  } as Job<JudgeVerdictPayload>;
}

function contextRow() {
  return {
    response_id: 'response-1',
    business_id: 'business-1',
    account_id: 'account-1',
    review_id: 'review-1',
    posted_reply_text: 'Thank you.',
    star_rating: 5,
    review_text: 'Great service.',
    subscription_status: 'active',
    subscription_tier: 'copilot',
    status: 'posted',
    approval_method: 'auto_policy',
  };
}

// Queue for the full terminal path: context load, anchor pre-read, reviews
// lock, businesses lock, outbox fail claim, agent-run lookup, verdict INSERT.
function pushTerminalSequence() {
  sqlReturnQueue.push(
    mkTaggedResult([contextRow()]),
    mkTaggedResult([{ review_id: 'review-1' }]),
    mkTaggedResult([{ id: 'review-1' }]),
    mkTaggedResult([{ id: 'business-1' }]),
    mkTaggedResult([{}]),
    mkTaggedResult([{ id: 'run-1' }]),
    mkTaggedResult([{ id: 'verdict-1' }]),
  );
}

describe('JudgeWorker failed hook', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetMockSql();
  });

  it.each([1, 2])('does nothing at %s/3 attempts while BullMQ still has a retry', async (attemptsMade) => {
    await handleJudgeFailed(
      mockSql as never,
      failedJob(attemptsMade),
      new TypeError('secret raw text'),
    );

    expect(sqlCalls).toHaveLength(0);
  });

  it('anchors, locks businesses, atomically claims failure, then writes a bounded error verdict', async () => {
    pushTerminalSequence();

    await handleJudgeFailed(
      mockSql as never,
      failedJob(3),
      new TypeError('raw review and response must not be persisted'),
    );

    // Runtime lock-order pin: reviews anchor -> explicit businesses lock ->
    // outbox claim -> verdict INSERT (whose FK locks now follow the lane order).
    expect(sqlCalls[1]!.text).toContain('SELECT review_id FROM responses');
    expect(sqlCalls[2]!.text).toContain('SELECT id FROM reviews');
    expect(sqlCalls[3]!.text).toContain('FROM businesses');
    expect(sqlCalls[3]!.text).toContain('FOR UPDATE');
    expect(sqlCalls[4]!.text).toContain("SET status = 'failed'");
    expect(sqlCalls[5]!.text).toContain('FROM agent_runs');
    expect(sqlCalls[6]!.text).toContain('INSERT INTO judge_verdicts');
    expect(sqlCalls[6]!.values).toContain('error');
    expect(sqlCalls[6]!.values).toContain('TypeError');
    expect(sqlCalls[6]!.values).not.toContain('raw review and response must not be persisted');
    // FIX-9: error verdicts never attribute a real model — the failure may
    // have been pre-LLM or on the fallback provider.
    expect(sqlCalls[6]!.values).toContain('unavailable');
    expect(sqlCalls[6]!.values).not.toContain('gpt-4o-mini-2024-07-18');
    // Non-budget failures carry no machine-readable reasons marker.
    expect(sqlCalls[6]!.values).toContain(null);
    expect(mockSql.json).not.toHaveBeenCalled();
  });

  it('marks a budget-decision failure (error name) with the budget_exceeded reasons marker', async () => {
    pushTerminalSequence();
    const budgetError = new Error('Daily cost limit exceeded for business business-1');
    budgetError.name = 'CostLimitExceededError';

    await handleJudgeFailed(mockSql as never, failedJob(3), budgetError);

    const insert = sqlCalls.find((call) => call.text.includes('INSERT INTO judge_verdicts'))!;
    expect(insert.values).toContain('error');
    expect(insert.values).toContain('CostLimitExceededError');
    expect(insert.values).toContain('unavailable');
    expect(mockSql.json).toHaveBeenCalledWith(['budget_exceeded']);
    expect(insert.values.some(
      (value) => Array.isArray(value) && value.includes('budget_exceeded'),
    )).toBe(true);
  });

  it('classifies a rehydrated budget failure via job.failedReason when the error object is opaque', async () => {
    pushTerminalSequence();

    await handleJudgeFailed(
      mockSql as never,
      failedJob(3, 'Global daily cost limit exceeded'),
      'opaque non-error rejection',
    );

    const insert = sqlCalls.find((call) => call.text.includes('INSERT INTO judge_verdicts'))!;
    expect(insert.values).toContain('UnknownError');
    expect(mockSql.json).toHaveBeenCalledWith(['budget_exceeded']);
  });

  it('does not write a verdict when a newer outbox attempt owns the row', async () => {
    sqlReturnQueue.push(
      mkTaggedResult([contextRow()]),
      mkTaggedResult([{ review_id: 'review-1' }]),
      mkTaggedResult([{ id: 'review-1' }]),
      mkTaggedResult([{ id: 'business-1' }]),
      mkTaggedResult([]),
    );

    await handleJudgeFailed(mockSql as never, failedJob(3), new Error('failure'));

    expect(sqlCalls).toHaveLength(5);
    expect(sqlCalls.some((call) => call.text.includes('INSERT INTO judge_verdicts'))).toBe(false);
  });
});
