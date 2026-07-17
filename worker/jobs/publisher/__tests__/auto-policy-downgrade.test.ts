import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockSql, sqlReturnQueue, sqlCalls, resetMockSql, mkTaggedResult } =
  await vi.hoisted(async () => {
    const helpers = await import('../../../__tests__/helpers/mock-sql');
    return { ...helpers.createMockSql(), mkTaggedResult: helpers.mkTaggedResult };
  });

import { downgradeAutoApprovedResponseForManualReview } from '../auto-policy-downgrade';

const logger = { warn: vi.fn() };

function input() {
  return {
    responseId: 'response-1',
    businessId: 'business-1',
    outboxId: 'outbox-1',
    outboxAttempt: 2,
    correlationId: 'correlation-1',
    reason: 'judge_unhealthy' as const,
    logger,
  };
}

describe('downgradeAutoApprovedResponseForManualReview ownership', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetMockSql();
  });

  it('does no durable work when a newer outbox attempt owns the response', async () => {
    sqlReturnQueue.push(
      mkTaggedResult([{ review_id: 'review-1' }]),
      mkTaggedResult([{ id: 'review-1' }]),
      mkTaggedResult([{ id: 'business-1' }]),
      mkTaggedResult([{ status: 'approved', approval_method: 'auto_policy' }]),
      mkTaggedResult([]),
    );

    await expect(
      downgradeAutoApprovedResponseForManualReview(mockSql as never, input()),
    ).resolves.toBe('no-op');

    expect(sqlCalls[0]!.text).toContain('SELECT review_id FROM responses');
    expect(sqlCalls[1]!.text).toContain('SELECT id FROM reviews');
    expect(sqlCalls[2]!.text).toContain('FROM businesses');
    expect(sqlCalls[3]!.text).toContain('FROM responses');
    expect(sqlCalls[4]!.text).toContain("SET status = 'completed'");
    expect(sqlCalls[4]!.values).toEqual(['outbox-1', 2]);
    expect(sqlCalls.some((call) => call.text.includes("status = 'pending_approval'"))).toBe(false);
    expect(sqlCalls.some((call) => call.text.includes('approval_audit_log'))).toBe(false);
    expect(sqlCalls.some((call) => call.text.includes('INSERT INTO job_outbox'))).toBe(false);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('claims the dispatched attempt before mutating the response and writing follow-ups', async () => {
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

    await expect(
      downgradeAutoApprovedResponseForManualReview(mockSql as never, input()),
    ).resolves.toBe('downgraded');

    expect(sqlCalls.map((call) => call.text)).toEqual([
      expect.stringContaining('SELECT review_id FROM responses'),
      expect.stringContaining('SELECT id FROM reviews'),
      expect.stringContaining('FROM businesses'),
      expect.stringContaining('FOR UPDATE'),
      expect.stringContaining("SET status = 'completed'"),
      expect.stringContaining("status = 'pending_approval'"),
      expect.stringContaining('SELECT account_id'),
      expect.stringContaining('INSERT INTO approval_audit_log'),
      expect.stringContaining('INSERT INTO job_outbox'),
    ]);
    expect(sqlCalls[4]!.values).toEqual(['outbox-1', 2]);
    expect(sqlCalls[5]!.values).toContain('auto_policy_revoked_judge_unavailable');
    expect(logger.warn).toHaveBeenCalledOnce();
  });

  it('uses a distinct bounded marker and reason for Autopilot entitlement loss', async () => {
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

    await expect(downgradeAutoApprovedResponseForManualReview(mockSql as never, {
      ...input(),
      reason: 'autopilot_entitlement_lost',
    })).resolves.toBe('downgraded');

    expect(sqlCalls[5]!.values).toContain('auto_policy_revoked_tier_entitlement');
    expect(sqlCalls[7]!.values).toContainEqual(expect.objectContaining({
      downgrade_reason: 'autopilot_entitlement_lost',
      runtime_enabled: true,
    }));
  });
});
