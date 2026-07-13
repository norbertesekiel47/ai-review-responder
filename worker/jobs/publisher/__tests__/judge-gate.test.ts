import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockSql,
  sqlReturnQueue,
  sqlCalls,
  resetMockSql,
  mkTaggedResult,
  mockJudgeEnabled,
  mockIsJudgeHealthy,
} = await vi.hoisted(async () => {
  const helpers = await import('../../../__tests__/helpers/mock-sql');
  return {
    ...helpers.createMockSql(),
    mkTaggedResult: helpers.mkTaggedResult,
    mockJudgeEnabled: vi.fn(() => false),
    mockIsJudgeHealthy: vi.fn(),
  };
});

vi.mock('@/lib/responses/judge-flags', () => ({ judgeEnabled: mockJudgeEnabled }));
vi.mock('@/lib/responses/judge-health', () => ({ isJudgeHealthy: mockIsJudgeHealthy }));

import { applyJudgeGate } from '../judge-gate';

const logger = { warn: vi.fn() };

function gateContext() {
  return {
    responseId: 'response-1',
    businessId: 'business-1',
    outboxId: 'outbox-1',
    outboxAttempt: 2,
    correlationId: 'correlation-1',
    logger,
  };
}

describe('applyJudgeGate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetMockSql();
    mockJudgeEnabled.mockReturnValue(false);
  });

  it('downgrades with the durable judge-unavailable marker when the flag is off', async () => {
    sqlReturnQueue.push(
      mkTaggedResult([{ review_id: 'review-1' }]),
      mkTaggedResult([{ id: 'review-1' }]),
      mkTaggedResult([{ id: 'business-1' }]),
      mkTaggedResult([{ status: 'approved', approval_method: 'auto_policy' }]),
      mkTaggedResult([{}]),
      mkTaggedResult([{ id: 'response-1' }]),
      mkTaggedResult([{ account_id: 'account-1' }]),
      mkTaggedResult([]),
      mkTaggedResult([]),
    );

    await expect(applyJudgeGate(mockSql as never, gateContext())).resolves.toBe('downgraded');

    expect(mockIsJudgeHealthy).not.toHaveBeenCalled();
    expect(sqlCalls[0]!.text).toContain('SELECT review_id FROM responses');
    expect(sqlCalls[1]!.text).toContain('SELECT id FROM reviews');
    expect(sqlCalls[2]!.text).toContain('FROM businesses');
    expect(sqlCalls[4]!.text).toContain("SET status = 'completed'");
    expect(sqlCalls[5]!.text).toContain("status = 'pending_approval'");
    expect(sqlCalls[5]!.values).toContain('auto_policy_revoked_judge_unavailable');
    expect(sqlCalls[7]!.values).toContain('auto_policy_revoked_judge_unavailable');
    expect(mockSql.json).toHaveBeenCalledWith(expect.objectContaining({
      downgrade_reason: 'judge_disabled',
      runtime_enabled: true,
    }));
  });

  it('downgrades with judge_unhealthy metadata when health signals are unsafe', async () => {
    mockJudgeEnabled.mockReturnValue(true);
    mockIsJudgeHealthy.mockResolvedValueOnce(false);
    sqlReturnQueue.push(
      mkTaggedResult([{ review_id: 'review-1' }]),
      mkTaggedResult([{ id: 'review-1' }]),
      mkTaggedResult([{ id: 'business-1' }]),
      mkTaggedResult([{ status: 'approved', approval_method: 'auto_policy' }]),
      mkTaggedResult([{}]),
      mkTaggedResult([{ id: 'response-1' }]),
      mkTaggedResult([{ account_id: 'account-1' }]),
      mkTaggedResult([]),
      mkTaggedResult([]),
    );

    await expect(applyJudgeGate(mockSql as never, gateContext())).resolves.toBe('downgraded');

    expect(mockIsJudgeHealthy).toHaveBeenCalledWith(mockSql);
    expect(sqlCalls[5]!.values).toContain('auto_policy_revoked_judge_unavailable');
    expect(mockSql.json).toHaveBeenCalledWith(expect.objectContaining({
      downgrade_reason: 'judge_unhealthy',
      runtime_enabled: true,
    }));
  });

  it('allows the auto-policy post when the Judge is enabled and healthy', async () => {
    mockJudgeEnabled.mockReturnValue(true);
    mockIsJudgeHealthy.mockResolvedValueOnce(true);

    await expect(applyJudgeGate(mockSql as never, gateContext())).resolves.toBe('post');

    expect(sqlCalls).toHaveLength(0);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('propagates a Judge health query failure without downgrading', async () => {
    const queryError = new Error('database unavailable');
    mockJudgeEnabled.mockReturnValue(true);
    mockIsJudgeHealthy.mockRejectedValueOnce(queryError);

    await expect(applyJudgeGate(mockSql as never, gateContext())).rejects.toBe(queryError);

    expect(sqlCalls).toHaveLength(0);
    expect(logger.warn).not.toHaveBeenCalled();
  });
});
