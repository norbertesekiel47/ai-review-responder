import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockSql, sqlReturnQueue, sqlCalls, resetMockSql, mkTaggedResult } =
  await vi.hoisted(async () => {
    const helpers = await import('../../../../worker/__tests__/helpers/mock-sql');
    return { ...helpers.createMockSql(), mkTaggedResult: helpers.mkTaggedResult };
  });

import { suspendAccountAutonomy, unsuspendAccountAutonomy } from '../suspension';

describe('autonomy suspension writer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetMockSql();
  });

  it('atomically suspends a rowless account and records both follow-ups once', async () => {
    sqlReturnQueue.push(
      mkTaggedResult([{ id: 'account-1' }]),
      mkTaggedResult([{ id: 'policy-1' }]),
    );

    const result = await suspendAccountAutonomy(mockSql as never, {
      accountId: 'account-1',
      trigger: 'judge_flag',
      suspensionEventId: 'event-1',
      evidence: { verdict_id: 'verdict-1' },
    });

    expect(result).toEqual({ newlySuspended: true });
    expect(sqlCalls).toHaveLength(5);
    expect(sqlCalls[0]!.text).toContain('FROM accounts');
    expect(sqlCalls[0]!.text).toContain('FOR UPDATE');
    expect(sqlCalls[1]!.text).toContain('INSERT INTO auto_approval_policies');
    expect(sqlCalls[1]!.text).toContain('auto_approve_min_star');
    expect(sqlCalls[1]!.text).toContain('ON CONFLICT (account_id, persona, action_class) WHERE location_id IS NULL');
    expect(sqlCalls[1]!.text).toContain('WHERE auto_approval_policies.suspended_at IS NULL');
    expect(sqlCalls[1]!.text).toContain('RETURNING id');

    expect(sqlCalls[2]!.text).toContain('INSERT INTO account_audit_log');
    expect(sqlCalls[2]!.values).toContain('autonomy_suspended');
    expect(sqlCalls[3]!.values).toContain('autonomy_suspended_notice');
    expect(sqlCalls[4]!.values).toContain('autonomy_admin_alert');
    expect(mockSql.json).toHaveBeenCalledWith({
      trigger: 'judge_flag',
      suspension_event_id: 'event-1',
      evidence: { verdict_id: 'verdict-1' },
    });
  });

  it('treats an already-suspended account as a total no-op', async () => {
    sqlReturnQueue.push(mkTaggedResult([{ id: 'account-1' }]), mkTaggedResult([]));

    const result = await suspendAccountAutonomy(mockSql as never, {
      accountId: 'account-1',
      trigger: 'governor_veto_rate',
      suspensionEventId: 'event-replay',
      evidence: { rate: 0.5, numer: 3, denom: 6, windowDays: 7 },
    });

    expect(result).toEqual({ newlySuspended: false });
    expect(sqlCalls).toHaveLength(2);
    expect(sqlCalls[0]!.text).toContain('FROM accounts');
    expect(sqlCalls[1]!.text).toContain('WHERE auto_approval_policies.suspended_at IS NULL');
    expect(mockSql.json).not.toHaveBeenCalled();
  });

  it('returns a total no-op when the account default is not suspended', async () => {
    sqlReturnQueue.push(mkTaggedResult([{ id: 'account-1' }]), mkTaggedResult([]));

    const result = await unsuspendAccountAutonomy(mockSql as never, {
      accountId: 'account-1',
      actorUserId: 'admin-1',
      note: 'Reviewed with the owner.',
    });

    expect(result).toEqual({ unsuspended: false, rearmed: false });
    expect(sqlCalls).toHaveLength(2);
    expect(sqlCalls[0]!.text).toContain('FROM accounts');
    expect(sqlCalls[1]!.text).toContain('AND suspended_at IS NOT NULL');
    expect(mockSql.json).not.toHaveBeenCalled();
  });

  it.each([
    { threshold: 4, rearmed: true },
    { threshold: null, rearmed: false },
  ])('derives rearmed=$rearmed from the stored threshold and audits the prior reason', async ({ threshold, rearmed }) => {
    sqlReturnQueue.push(
      mkTaggedResult([{ id: 'account-1' }]),
      mkTaggedResult([{
        previous_reason: 'A safety review paused auto-posting.',
        auto_approve_min_star: threshold,
      }]),
    );

    const result = await unsuspendAccountAutonomy(mockSql as never, {
      accountId: 'account-1',
      actorUserId: 'admin-1',
      note: 'Reviewed with the owner.',
    });

    expect(result).toEqual({ unsuspended: true, rearmed });
    expect(sqlCalls).toHaveLength(3);
    expect(sqlCalls[0]!.text).toContain('FROM accounts');
    expect(sqlCalls[1]!.text).toContain('UPDATE auto_approval_policies');
    expect(sqlCalls[1]!.text).toContain('RETURNING target.suspended_reason AS previous_reason');
    expect(sqlCalls[2]!.values).toContain('autonomy_unsuspended');
    expect(sqlCalls[2]!.values).toContain('admin-1');
    expect(mockSql.json).toHaveBeenCalledWith({
      note: 'Reviewed with the owner.',
      previous_reason: 'A safety review paused auto-posting.',
    });
  });
});
