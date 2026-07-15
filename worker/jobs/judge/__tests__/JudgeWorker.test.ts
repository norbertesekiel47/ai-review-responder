import type { Job } from 'bullmq';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockSql,
  sqlReturnQueue,
  sqlCalls,
  resetMockSql,
  mkTaggedResult,
  mockJudgeEnabled,
  mockJudgeResponse,
} = await vi.hoisted(async () => {
  const helpers = await import('../../../__tests__/helpers/mock-sql');
  return {
    ...helpers.createMockSql(),
    mkTaggedResult: helpers.mkTaggedResult,
    mockJudgeEnabled: vi.fn(() => false),
    mockJudgeResponse: vi.fn(),
  };
});

vi.mock('@/lib/responses/judge-flags', () => ({ judgeEnabled: mockJudgeEnabled }));
vi.mock('@/lib/responses/judge', () => ({ judgeResponse: mockJudgeResponse }));

import type { JudgeVerdictPayload } from '@/lib/shared/worker-types';
import { handleJudgeVerdict } from '../JudgeWorker';

function job(): Job<JudgeVerdictPayload> {
  return {
    id: 'bull-job-1',
    data: {
      response_id: 'response-1',
      business_id: 'business-1',
      account_id: 'account-1',
      outbox_id: 'outbox-1',
      outbox_attempt: 2,
    },
  } as Job<JudgeVerdictPayload>;
}

function activeContext(overrides: Record<string, unknown> = {}) {
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
    ...overrides,
  };
}

describe('JudgeWorker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetMockSql();
    mockJudgeEnabled.mockReturnValue(false);
  });

  it('completes immediately when the judge kill switch is off', async () => {
    sqlReturnQueue.push(mkTaggedResult([{}]));

    await handleJudgeVerdict(mockSql as never, job());

    expect(sqlCalls).toHaveLength(1);
    expect(sqlCalls[0]!.text).toContain("SET status = 'completed'");
    expect(sqlCalls[0]!.text).toContain("status = 'dispatched'");
    expect(sqlCalls[0]!.values).toEqual(['outbox-1', 2]);
    expect(mockJudgeResponse).not.toHaveBeenCalled();
  });

  it('completes without judging when the account lacks full subscription access', async () => {
    mockJudgeEnabled.mockReturnValue(true);
    sqlReturnQueue.push(mkTaggedResult([activeContext({ subscription_status: 'cancelled' })]));
    sqlReturnQueue.push(mkTaggedResult([{}]));

    await handleJudgeVerdict(mockSql as never, job());

    expect(sqlCalls).toHaveLength(2);
    expect(sqlCalls[0]!.text).toContain('JOIN accounts a ON a.id = b.account_id');
    expect(sqlCalls[1]!.text).toContain("SET status = 'completed'");
    expect(mockJudgeResponse).not.toHaveBeenCalled();
  });

  it('propagates judge failures before opening a transaction', async () => {
    const transientError = new Error('redis transport unavailable');
    mockJudgeEnabled.mockReturnValue(true);
    mockJudgeResponse.mockRejectedValueOnce(transientError);
    sqlReturnQueue.push(mkTaggedResult([activeContext()]));

    await expect(handleJudgeVerdict(mockSql as never, job())).rejects.toBe(transientError);

    expect(mockJudgeResponse).toHaveBeenCalledWith(mockSql, {
      responseId: 'response-1',
      businessId: 'business-1',
      accountId: 'account-1',
      subscriptionTier: 'copilot',
      reviewRating: 5,
      reviewText: 'Great service.',
      postedReplyText: 'Thank you.',
    });
    expect(mockSql.begin).not.toHaveBeenCalled();
    expect(sqlCalls).toHaveLength(1);
  });

  it('judges an auto-post while its past-due account is inside publisher grace', async () => {
    const judgeError = new Error('judge boundary reached');
    mockJudgeEnabled.mockReturnValue(true);
    mockJudgeResponse.mockRejectedValueOnce(judgeError);
    sqlReturnQueue.push(mkTaggedResult([activeContext({
      subscription_status: 'past_due',
      account_past_due_at: new Date(Date.now() - 2 * 86_400_000),
      account_flags: {},
    })]));

    await expect(handleJudgeVerdict(mockSql as never, job())).rejects.toBe(judgeError);

    expect(mockJudgeResponse).toHaveBeenCalledTimes(1);
    expect(mockSql.begin).not.toHaveBeenCalled();
  });

  it('does not judge after the publisher past-due grace has expired', async () => {
    mockJudgeEnabled.mockReturnValue(true);
    sqlReturnQueue.push(
      mkTaggedResult([activeContext({
        subscription_status: 'past_due',
        account_past_due_at: new Date(Date.now() - 8 * 86_400_000),
        account_flags: {},
      })]),
      mkTaggedResult([{}]),
    );

    await handleJudgeVerdict(mockSql as never, job());

    expect(mockJudgeResponse).not.toHaveBeenCalled();
    expect(sqlCalls.at(-1)!.text).toContain("SET status = 'completed'");
  });

  it('anchors reviews, locks businesses then the response then the account, persists a flag verdict, suspends autonomy, and completes atomically', async () => {
    mockJudgeEnabled.mockReturnValue(true);
    mockJudgeResponse.mockResolvedValueOnce({
      verdict: 'flag',
      reasons: ['fabricated_fact'],
      rationale: 'The reply invents an unsupported detail.',
      model: 'pinned-model',
      promptVersion: 'judge-v1',
    });
    sqlReturnQueue.push(
      mkTaggedResult([activeContext()]),
      mkTaggedResult([{ review_id: 'review-1' }]),
      mkTaggedResult([{ id: 'review-1' }]),
      mkTaggedResult([{ id: 'business-1' }]),
      mkTaggedResult([{ status: 'posted', approval_method: 'auto_policy' }]),
      mkTaggedResult([{}]),
      mkTaggedResult([{ id: 'run-1' }]),
      mkTaggedResult([{ id: 'account-1' }]),
      mkTaggedResult([{ id: 'verdict-1' }]),
      mkTaggedResult([{ id: 'account-1' }]),
      mkTaggedResult([{ id: 'policy-1' }]),
      mkTaggedResult([{}]),
      mkTaggedResult([{}]),
      mkTaggedResult([{}]),
    );

    await handleJudgeVerdict(mockSql as never, job());

    expect(mockSql.begin).toHaveBeenCalledTimes(1);
    // Runtime lock order pin (lane order reviews -> businesses -> responses ->
    // accounts): the source guard alone is blind to implicit-FK misordering.
    expect(sqlCalls[1]!.text).toContain('SELECT review_id FROM responses');
    expect(sqlCalls[2]!.text).toContain('SELECT id FROM reviews');
    expect(sqlCalls[3]!.text).toContain('FROM businesses');
    expect(sqlCalls[3]!.text).toContain('FOR UPDATE');
    expect(sqlCalls[4]!.text).toContain('FROM responses');
    expect(sqlCalls[4]!.text).toContain('FOR UPDATE');
    expect(sqlCalls[5]!.text).toContain("SET status = 'completed'");
    expect(sqlCalls[6]!.text).toContain('FROM agent_runs');
    // Flag branch: accounts FOR UPDATE pre-lock BEFORE the verdict INSERT —
    // the INSERT's RI trigger takes accounts FOR KEY SHARE, and a later
    // upgrade inside suspendAccountAutonomy deadlocks concurrent flags.
    expect(sqlCalls[7]!.text).toContain('FROM accounts');
    expect(sqlCalls[7]!.text).toContain('FOR UPDATE');
    expect(sqlCalls[8]!.text).toContain('INSERT INTO judge_verdicts');
    expect(sqlCalls[8]!.values).toContain('run-1');
    expect(sqlCalls[9]!.text).toContain('FROM accounts');
    expect(sqlCalls[9]!.text).toContain('FOR UPDATE');
    expect(sqlCalls[10]!.text).toContain('INSERT INTO auto_approval_policies');
    const verdictId = sqlCalls[8]!.values[0];
    expect(mockSql.json).toHaveBeenCalledWith({
      trigger: 'judge_flag',
      suspension_event_id: expect.any(String),
      evidence: { verdict_id: verdictId },
    });
  });

  it('completes without a verdict when current response state no longer qualifies', async () => {
    mockJudgeEnabled.mockReturnValue(true);
    mockJudgeResponse.mockResolvedValueOnce({
      verdict: 'pass', reasons: [], rationale: 'Safe.', model: 'pinned-model', promptVersion: 'judge-v1',
    });
    sqlReturnQueue.push(
      mkTaggedResult([activeContext()]),
      mkTaggedResult([{ review_id: 'review-1' }]),
      mkTaggedResult([{ id: 'review-1' }]),
      mkTaggedResult([{ id: 'business-1' }]),
      mkTaggedResult([{ status: 'posted', approval_method: 'owner' }]),
      mkTaggedResult([{}]),
    );

    await handleJudgeVerdict(mockSql as never, job());

    expect(sqlCalls[4]!.text).toContain('FOR UPDATE');
    expect(sqlCalls.some((call) => call.text.includes('INSERT INTO judge_verdicts'))).toBe(false);
    expect(sqlCalls.at(-1)!.text).toContain("SET status = 'completed'");
  });

  it('treats a concurrent verdict conflict as completed without suspending', async () => {
    mockJudgeEnabled.mockReturnValue(true);
    mockJudgeResponse.mockResolvedValueOnce({
      verdict: 'flag', reasons: ['brand_tone'], rationale: 'Unsafe.', model: 'pinned-model', promptVersion: 'judge-v1',
    });
    sqlReturnQueue.push(
      mkTaggedResult([activeContext()]),
      mkTaggedResult([{ review_id: 'review-1' }]),
      mkTaggedResult([{ id: 'review-1' }]),
      mkTaggedResult([{ id: 'business-1' }]),
      mkTaggedResult([{ status: 'posted', approval_method: 'auto_policy' }]),
      mkTaggedResult([{}]),
      mkTaggedResult([]),
      mkTaggedResult([{ id: 'account-1' }]),
      mkTaggedResult([]),
    );

    await handleJudgeVerdict(mockSql as never, job());

    expect(sqlCalls.some((call) => call.text.includes('INSERT INTO auto_approval_policies'))).toBe(false);
    expect(sqlCalls[5]!.text).toContain("SET status = 'completed'");
  });

  it('does not persist a verdict when a newer outbox attempt owns the row', async () => {
    mockJudgeEnabled.mockReturnValue(true);
    mockJudgeResponse.mockResolvedValueOnce({
      verdict: 'flag', reasons: ['brand_tone'], rationale: 'Unsafe.', model: 'pinned-model', promptVersion: 'judge-v1',
    });
    sqlReturnQueue.push(
      mkTaggedResult([activeContext()]),
      mkTaggedResult([{ review_id: 'review-1' }]),
      mkTaggedResult([{ id: 'review-1' }]),
      mkTaggedResult([{ id: 'business-1' }]),
      mkTaggedResult([{ status: 'posted', approval_method: 'auto_policy' }]),
      mkTaggedResult([]),
    );

    await handleJudgeVerdict(mockSql as never, job());

    expect(sqlCalls[5]!.text).toContain("SET status = 'completed'");
    expect(sqlCalls[5]!.values).toEqual(['outbox-1', 2]);
    expect(sqlCalls.some((call) => call.text.includes('INSERT INTO judge_verdicts'))).toBe(false);
    expect(sqlCalls.some((call) => call.text.includes('INSERT INTO auto_approval_policies'))).toBe(false);
  });

  it.each(['pass', 'warn'] as const)('stores %s without suspending autonomy', async (verdict) => {
    mockJudgeEnabled.mockReturnValue(true);
    mockJudgeResponse.mockResolvedValueOnce({
      verdict, reasons: [], rationale: 'Not suspension-worthy.', model: 'pinned-model', promptVersion: 'judge-v1',
    });
    sqlReturnQueue.push(
      mkTaggedResult([activeContext()]),
      mkTaggedResult([{ review_id: 'review-1' }]),
      mkTaggedResult([{ id: 'review-1' }]),
      mkTaggedResult([{ id: 'business-1' }]),
      mkTaggedResult([{ status: 'posted', approval_method: 'auto_policy' }]),
      mkTaggedResult([{}]),
      mkTaggedResult([]),
      mkTaggedResult([{ id: 'verdict-1' }]),
    );

    await handleJudgeVerdict(mockSql as never, job());

    const insert = sqlCalls.find((call) => call.text.includes('INSERT INTO judge_verdicts'))!;
    expect(insert.values).toContain(verdict);
    expect(sqlCalls.some((call) => call.text.includes('INSERT INTO auto_approval_policies'))).toBe(false);
    // Non-flag verdicts must NOT take the accounts pre-lock — routine passes
    // would otherwise serialize per account.
    expect(sqlCalls.some(
      (call) => call.text.includes('FROM accounts') && call.text.includes('FOR UPDATE'),
    )).toBe(false);
  });
});
