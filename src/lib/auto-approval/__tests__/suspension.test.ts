import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockSql, sqlReturnQueue, sqlCalls, resetMockSql, mkTaggedResult } =
  await vi.hoisted(async () => {
    const helpers = await import('../../../../worker/__tests__/helpers/mock-sql');
    return { ...helpers.createMockSql(), mkTaggedResult: helpers.mkTaggedResult };
  });

import {
  AUTONOMY_SUSPENSION_REASONS,
  listSuspendedPolicies,
  suspendAccountAutonomy,
  unsuspendAccountAutonomy,
} from '../suspension';

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

describe('listSuspendedPolicies', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetMockSql();
  });

  it('returns bounded account/location suspensions with current rates and at most five recent flags', async () => {
    const suspendedAt = new Date('2026-07-13T12:00:00.000Z');
    const windowStart = new Date('2026-07-10T12:00:00.000Z');
    const flagCreatedAt = new Date('2026-07-12T09:00:00.000Z');
    sqlReturnQueue.push(
      mkTaggedResult([
        {
          policy_id: 'policy-account',
          account_id: 'account-1',
          account_name: 'Northstar Dental',
          location_id: null,
          location_name: null,
          suspended_reason: AUTONOMY_SUSPENSION_REASONS.judge_flag,
          suspended_at: suspendedAt,
          window_start: windowStart,
          audit_trigger: 'judge_flag',
        },
        {
          // Copy-edited display reason: the trigger must still resolve from
          // the audit payload, never from string-matching the reason copy.
          policy_id: 'policy-location',
          account_id: 'account-1',
          account_name: 'Northstar Dental',
          location_id: 'location-1',
          location_name: 'Northstar Dental — West',
          suspended_reason: 'Owner edits recently exceeded our safety bar (reworded copy).',
          suspended_at: suspendedAt,
          window_start: windowStart,
          audit_trigger: 'governor_edit_rate',
        },
      ]),
      mkTaggedResult([{
        account_id: 'account-1',
        edited_count: 3,
        approved_count: 2,
        vetoed_count: 1,
        auto_posted_count: 9,
      }]),
      mkTaggedResult([{
        account_id: 'account-1', pass_count: 6, warn_count: 2, flag_count: 2,
      }]),
      mkTaggedResult([{
        id: 'verdict-1',
        account_id: 'account-1',
        business_id: 'location-1',
        review_id: 'review-1',
        response_id: 'response-1',
        reason_categories: ['fabricated_fact', 'unsafe_or_policy_violation'],
        created_at: flagCreatedAt,
      }]),
    );

    const result = await listSuspendedPolicies(mockSql as never);

    expect(result).toEqual([
      {
        policyId: 'policy-account',
        accountId: 'account-1',
        accountName: 'Northstar Dental',
        locationId: null,
        locationName: null,
        scope: 'account',
        suspendedReason: AUTONOMY_SUSPENSION_REASONS.judge_flag,
        trigger: 'judge_flag',
        suspendedAt,
        governorRates: {
          edit: { numerator: 3, denominator: 5, rate: 0.6 },
          veto: { numerator: 1, denominator: 10, rate: 0.1 },
          judgeSignal: { numerator: 4, denominator: 10, rate: 0.4 },
        },
        recentFlagVerdicts: [{
          id: 'verdict-1',
          businessId: 'location-1',
          reviewId: 'review-1',
          responseId: 'response-1',
          reasons: ['fabricated_fact', 'unsafe_or_policy_violation'],
          createdAt: flagCreatedAt,
        }],
      },
      expect.objectContaining({
        policyId: 'policy-location',
        scope: 'location',
        locationName: 'Northstar Dental — West',
        suspendedReason: 'Owner edits recently exceeded our safety bar (reworded copy).',
        trigger: 'governor_edit_rate',
      }),
    ]);
    expect(sqlCalls).toHaveLength(4);
    expect(sqlCalls[0]!.text).toContain('LIMIT 100');
    expect(sqlCalls[0]!.text).toContain('JOIN accounts');
    expect(sqlCalls[0]!.text).toContain('LEFT JOIN businesses');
    expect(sqlCalls[0]!.text).toContain("suspend_audit.event_type = 'autonomy_suspended'");
    expect(sqlCalls[0]!.text).toContain("suspend_audit.payload->>'trigger'");
    expect(sqlCalls[1]!.text).toContain('LEFT JOIN agent_outcomes');
    expect(sqlCalls[2]!.text).toContain('LEFT JOIN judge_verdicts');
    expect(sqlCalls[3]!.text).toContain('ROW_NUMBER() OVER');
    expect(sqlCalls[3]!.text).toMatch(/\bWHERE flag_rank <= 5\s+ORDER BY\b/);
    expect(sqlCalls[3]!.text).toContain("jsonb_typeof(verdict.reasons) = 'array'");
  });

  it('maps an unknown or missing audit trigger to null while keeping the display reason', async () => {
    const suspendedAt = new Date('2026-07-13T12:00:00.000Z');
    const windowStart = new Date('2026-07-10T12:00:00.000Z');
    sqlReturnQueue.push(
      mkTaggedResult([
        {
          policy_id: 'policy-unknown-trigger',
          account_id: 'account-1',
          account_name: 'Northstar Dental',
          location_id: null,
          location_name: null,
          suspended_reason: AUTONOMY_SUSPENSION_REASONS.judge_flag,
          suspended_at: suspendedAt,
          window_start: windowStart,
          audit_trigger: 'retired_trigger_kind',
        },
        {
          policy_id: 'policy-no-audit',
          account_id: 'account-1',
          account_name: 'Northstar Dental',
          location_id: null,
          location_name: null,
          suspended_reason: AUTONOMY_SUSPENSION_REASONS.governor_veto_rate,
          suspended_at: suspendedAt,
          window_start: windowStart,
          audit_trigger: null,
        },
      ]),
      mkTaggedResult([{
        account_id: 'account-1',
        edited_count: 0,
        approved_count: 0,
        vetoed_count: 0,
        auto_posted_count: 0,
      }]),
      mkTaggedResult([{ account_id: 'account-1', pass_count: 0, warn_count: 0, flag_count: 0 }]),
      mkTaggedResult([]),
    );

    const result = await listSuspendedPolicies(mockSql as never);

    expect(result[0]).toMatchObject({
      policyId: 'policy-unknown-trigger',
      suspendedReason: AUTONOMY_SUSPENSION_REASONS.judge_flag,
      trigger: null,
    });
    expect(result[1]).toMatchObject({
      policyId: 'policy-no-audit',
      suspendedReason: AUTONOMY_SUSPENSION_REASONS.governor_veto_rate,
      trigger: null,
    });
  });

  it('does not issue rate or verdict queries when no policies are suspended', async () => {
    sqlReturnQueue.push(mkTaggedResult([]));

    await expect(listSuspendedPolicies(mockSql as never)).resolves.toEqual([]);
    expect(sqlCalls).toHaveLength(1);
  });

  it('uses exactly four statements for one hundred distinct suspended accounts', async () => {
    const windowStart = new Date('2026-07-10T00:00:00.000Z');
    const suspendedAt = new Date('2026-07-13T00:00:00.000Z');
    const accountIds = Array.from({ length: 100 }, (_, index) =>
      `00000000-0000-4000-8000-${index.toString().padStart(12, '0')}`);
    sqlReturnQueue.push(
      mkTaggedResult(accountIds.map((accountId, index) => ({
        policy_id: `policy-${index}`,
        account_id: accountId,
        account_name: `Account ${index}`,
        location_id: null,
        location_name: null,
        suspended_reason: AUTONOMY_SUSPENSION_REASONS.governor_veto_rate,
        suspended_at: suspendedAt,
        window_start: windowStart,
        audit_trigger: 'governor_veto_rate',
      }))),
      mkTaggedResult(accountIds.map((accountId, index) => ({
        account_id: accountId,
        edited_count: index === 0 ? 3 : 0,
        approved_count: index === 0 ? 2 : 5,
        vetoed_count: index === 99 ? 2 : 0,
        auto_posted_count: 5,
      }))),
      mkTaggedResult(accountIds.map((accountId, index) => ({
        account_id: accountId,
        pass_count: 4,
        warn_count: 0,
        flag_count: index === 99 ? 1 : 0,
      }))),
      mkTaggedResult([]),
    );

    const result = await listSuspendedPolicies(mockSql as never);

    expect(sqlCalls).toHaveLength(4);
    expect(result).toHaveLength(100);
    expect(result[0]!.governorRates.edit).toEqual({ numerator: 3, denominator: 5, rate: 0.6 });
    expect(result[99]!.governorRates).toMatchObject({
      veto: { numerator: 2, denominator: 7, rate: 2 / 7 },
      judgeSignal: { numerator: 1, denominator: 5, rate: 0.2 },
    });
  });
});
