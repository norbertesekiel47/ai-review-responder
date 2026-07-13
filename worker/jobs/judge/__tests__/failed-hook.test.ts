import type { Job } from 'bullmq';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockSql, sqlReturnQueue, sqlCalls, resetMockSql, mkTaggedResult } =
  await vi.hoisted(async () => {
    const helpers = await import('../../../__tests__/helpers/mock-sql');
    return { ...helpers.createMockSql(), mkTaggedResult: helpers.mkTaggedResult };
  });

import type { JudgeVerdictPayload } from '@/lib/shared/worker-types';
import { handleJudgeFailed } from '../failed-hook';

function failedJob(attemptsMade: number): Job<JudgeVerdictPayload> {
  return {
    id: 'bull-job-1',
    attemptsMade,
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

  it('anchors first and atomically claims failure before writing a bounded error verdict', async () => {
    sqlReturnQueue.push(
      mkTaggedResult([{
        response_id: 'response-1',
        business_id: 'business-1',
        account_id: 'account-1',
        review_id: 'review-1',
        posted_reply_text: 'Thank you.',
        star_rating: 5,
        review_text: 'Great service.',
        subscription_status: 'active',
        subscription_tier: 'standard',
        status: 'posted',
        approval_method: 'auto_policy',
      }]),
      mkTaggedResult([{ review_id: 'review-1' }]),
      mkTaggedResult([{ id: 'review-1' }]),
      mkTaggedResult([{}]),
      mkTaggedResult([{ id: 'run-1' }]),
      mkTaggedResult([{ id: 'verdict-1' }]),
    );

    await handleJudgeFailed(
      mockSql as never,
      failedJob(3),
      new TypeError('raw review and response must not be persisted'),
    );

    expect(sqlCalls[1]!.text).toContain('SELECT review_id FROM responses');
    expect(sqlCalls[2]!.text).toContain('SELECT id FROM reviews');
    expect(sqlCalls[3]!.text).toContain("SET status = 'failed'");
    expect(sqlCalls[4]!.text).toContain('FROM agent_runs');
    expect(sqlCalls[5]!.text).toContain('INSERT INTO judge_verdicts');
    expect(sqlCalls[5]!.values).toContain('error');
    expect(sqlCalls[5]!.values).toContain('TypeError');
    expect(sqlCalls[5]!.values).not.toContain('raw review and response must not be persisted');
  });

  it('does not write a verdict when a newer outbox attempt owns the row', async () => {
    sqlReturnQueue.push(
      mkTaggedResult([{
        response_id: 'response-1', business_id: 'business-1', account_id: 'account-1',
        review_id: 'review-1', posted_reply_text: 'Thanks', star_rating: 5,
        review_text: 'Good', subscription_status: 'active', subscription_tier: 'standard',
        status: 'posted', approval_method: 'auto_policy',
      }]),
      mkTaggedResult([{ review_id: 'review-1' }]),
      mkTaggedResult([{ id: 'review-1' }]),
      mkTaggedResult([]),
    );

    await handleJudgeFailed(mockSql as never, failedJob(3), new Error('failure'));

    expect(sqlCalls).toHaveLength(4);
    expect(sqlCalls.some((call) => call.text.includes('INSERT INTO judge_verdicts'))).toBe(false);
  });
});
