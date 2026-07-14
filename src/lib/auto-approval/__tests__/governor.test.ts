import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockSql, sqlReturnQueue, sqlCalls, resetMockSql, mkTaggedResult } =
  await vi.hoisted(async () => {
    const helpers = await import('../../../../worker/__tests__/helpers/mock-sql');
    return { ...helpers.createMockSql(), mkTaggedResult: helpers.mkTaggedResult };
  });

import {
  computeGovernorRates,
  computeGovernorRatesForAccounts,
  evaluateAccount,
  GOVERNOR_EDIT_RATE_THRESHOLD,
  GOVERNOR_JUDGE_SIGNAL_RATE_THRESHOLD,
  GOVERNOR_MIN_SAMPLE,
  GOVERNOR_VETO_RATE_THRESHOLD,
  GOVERNOR_WINDOW_DAYS,
  listGovernorCandidates,
  revalidateGovernorCandidate,
  type GovernorRates,
} from '../governor';

function rates(overrides: Partial<GovernorRates> = {}): GovernorRates {
  return {
    edit: { numerator: 0, denominator: 0, rate: 0 },
    veto: { numerator: 0, denominator: 0, rate: 0 },
    judgeSignal: { numerator: 0, denominator: 0, rate: 0 },
    ...overrides,
  };
}

describe('governor frozen thresholds', () => {
  it('enforces the sample floor before the edit-rate threshold', () => {
    expect(GOVERNOR_WINDOW_DAYS).toBe(7);
    expect(GOVERNOR_MIN_SAMPLE).toBe(5);
    expect(GOVERNOR_EDIT_RATE_THRESHOLD).toBe(0.5);
    expect(GOVERNOR_VETO_RATE_THRESHOLD).toBe(0.3);
    expect(GOVERNOR_JUDGE_SIGNAL_RATE_THRESHOLD).toBe(0.4);

    expect(evaluateAccount(rates({
      edit: { numerator: 4, denominator: 4, rate: 1 },
    }))).toBeNull();

    expect(evaluateAccount(rates({
      edit: { numerator: 3, denominator: 5, rate: 0.6 },
    }))).toEqual({
      trigger: 'governor_edit_rate',
      evidence: { rate: 0.6, numer: 3, denom: 5, windowDays: 7 },
    });
  });

  it('trips at exact thresholds and returns the first breached rate', () => {
    expect(evaluateAccount(rates({
      edit: { numerator: 3, denominator: 6, rate: 0.5 },
      veto: { numerator: 3, denominator: 10, rate: 0.3 },
      judgeSignal: { numerator: 2, denominator: 5, rate: 0.4 },
    }))?.trigger).toBe('governor_edit_rate');

    expect(evaluateAccount(rates({
      veto: { numerator: 3, denominator: 10, rate: 0.3 },
    }))?.trigger).toBe('governor_veto_rate');

    expect(evaluateAccount(rates({
      judgeSignal: { numerator: 2, denominator: 5, rate: 0.4 },
    }))?.trigger).toBe('governor_judge_signal_rate');
  });
});

describe('governor data scans', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetMockSql();
  });

  it('includes armed override-only accounts unless an existing account-default is suspended', async () => {
    const windowStart = new Date('2026-07-12T00:00:00.000Z');
    sqlReturnQueue.push(mkTaggedResult([{ account_id: 'account-1', window_start: windowStart }]));

    const candidates = await listGovernorCandidates(mockSql as never, 50);
    expect([...candidates]).toEqual([
      { account_id: 'account-1', window_start: windowStart },
    ]);

    const query = sqlCalls[0]!;
    expect(query.text).toContain('FROM auto_approval_policies armed');
    expect(query.text).toContain('armed.auto_approve_min_star IS NOT NULL');
    expect(query.text).toContain('NOT EXISTS');
    expect(query.text).toContain('FROM auto_approval_policies account_default');
    expect(query.text).toContain('account_default.account_id = armed.account_id');
    expect(query.text).toContain('account_default.location_id IS NULL');
    expect(query.text).toContain("account_default.persona = 'reply'");
    expect(query.text).toContain("account_default.action_class = 'posting'");
    expect(query.text).toContain('account_default.suspended_at IS NOT NULL');
    expect(query.text).not.toContain('JOIN auto_approval_policies account_default');
    expect(query.text).toContain("aal.event_type = 'autonomy_unsuspended'");
    expect(query.text).toContain('GREATEST');
    expect(query.text).toContain('MAX(aal.created_at)');
    expect(query.text).toContain('COALESCE(armed.account_id > ?::uuid, TRUE)');
    expect(query.text).toContain('LIMIT ?');
    expect(query.values).toEqual([7, null, 50]);
  });

  it('rotates deterministically after the prior account and wraps to the start', async () => {
    sqlReturnQueue.push(mkTaggedResult([]));

    await listGovernorCandidates(mockSql as never, 50, '00000000-0000-4000-8000-000000000050');

    const query = sqlCalls[0]!;
    expect(query.text).toContain('ORDER BY');
    expect(query.text).toContain('COALESCE(armed.account_id > ?::uuid, TRUE)');
    expect(query.text).toContain('THEN 0 ELSE 1');
    expect(query.values).toEqual([
      7,
      '00000000-0000-4000-8000-000000000050',
      50,
    ]);
  });

  it('counts owner decisions, auto-post qualifiers, and non-error verdicts without double-counting reply_posted', async () => {
    const windowStart = new Date('2026-07-10T00:00:00.000Z');
    sqlReturnQueue.push(
      mkTaggedResult([{
        account_id: 'account-1',
        edited_count: 3,
        approved_count: 2,
        vetoed_count: 1,
        auto_posted_count: 4,
      }]),
      mkTaggedResult([{ account_id: 'account-1', pass_count: 2, warn_count: 2, flag_count: 1 }]),
    );

    await expect(
      computeGovernorRates(mockSql as never, 'account-1', windowStart),
    ).resolves.toEqual({
      edit: { numerator: 3, denominator: 5, rate: 0.6 },
      veto: { numerator: 1, denominator: 5, rate: 0.2 },
      judgeSignal: { numerator: 3, denominator: 5, rate: 0.6 },
    });

    expect(sqlCalls).toHaveLength(2);
    expect(sqlCalls[0]!.text).toContain('LEFT JOIN agent_outcomes');
    expect(sqlCalls[0]!.text).toContain('SUM(outcome.unit_count)');
    expect(sqlCalls[0]!.values).toEqual(expect.arrayContaining([
      'reply_edited_by_owner',
      'reply_approved_no_edit',
      'reply_vetoed_by_owner',
      'reply_auto_posted',
      ['account-1'],
      [windowStart.toISOString()],
    ]));
    expect(sqlCalls[0]!.values).not.toContain('reply_posted');
    expect(sqlCalls[1]!.text).toContain('LEFT JOIN judge_verdicts');
    expect(sqlCalls[1]!.text).toContain("verdict IN ('pass', 'warn', 'flag')");
    expect(sqlCalls[1]!.text).not.toContain("verdict = 'error'");
  });

  it('batches multiple account windows into exactly two queries with shared projections', async () => {
    const firstWindow = new Date('2026-07-10T00:00:00.000Z');
    const secondWindow = new Date('2026-07-11T00:00:00.000Z');
    sqlReturnQueue.push(
      mkTaggedResult([
        { account_id: 'account-1', edited_count: 3, approved_count: 2, vetoed_count: 1, auto_posted_count: 4 },
        { account_id: 'account-2', edited_count: 0, approved_count: 5, vetoed_count: 2, auto_posted_count: 3 },
      ]),
      mkTaggedResult([
        { account_id: 'account-1', pass_count: 2, warn_count: 2, flag_count: 1 },
        { account_id: 'account-2', pass_count: 4, warn_count: 0, flag_count: 1 },
      ]),
    );

    const result = await computeGovernorRatesForAccounts(mockSql as never, [
      { accountId: 'account-1', windowStart: firstWindow },
      { accountId: 'account-2', windowStart: secondWindow },
    ]);

    expect(sqlCalls).toHaveLength(2);
    expect(result.get('account-1')).toEqual({
      edit: { numerator: 3, denominator: 5, rate: 0.6 },
      veto: { numerator: 1, denominator: 5, rate: 0.2 },
      judgeSignal: { numerator: 3, denominator: 5, rate: 0.6 },
    });
    expect(result.get('account-2')).toEqual({
      edit: { numerator: 0, denominator: 5, rate: 0 },
      veto: { numerator: 2, denominator: 5, rate: 0.4 },
      judgeSignal: { numerator: 1, denominator: 5, rate: 0.2 },
    });
    expect(sqlCalls[0]!.text).toContain('unnest(?::uuid[], ?::timestamptz[])');
    expect(sqlCalls[1]!.text).toContain('unnest(?::uuid[], ?::timestamptz[])');
  });

  it.each([0, 101, 1.5])('rejects unbounded candidate limit %s before querying', async (limit) => {
    await expect(listGovernorCandidates(mockSql as never, limit)).rejects.toThrow(RangeError);
    expect(sqlCalls).toHaveLength(0);
  });

  it('locks and accepts a still-armed override-only candidate with no newer unsuspend', async () => {
    const cutoff = new Date('2026-07-12T00:00:00.000Z');
    sqlReturnQueue.push(
      mkTaggedResult([{ id: 'account-1' }]),
      mkTaggedResult([{
        location_id: 'location-1',
        persona: 'reply',
        action_class: 'posting',
        auto_approve_min_star: 5,
        suspended_at: null,
      }]),
      mkTaggedResult([]),
    );

    await expect(revalidateGovernorCandidate(
      mockSql as never,
      'account-1',
      cutoff,
    )).resolves.toBe(true);

    expect(sqlCalls).toHaveLength(3);
    expect(sqlCalls[0]!.text).toContain('FROM accounts');
    expect(sqlCalls[0]!.text).toContain('FOR UPDATE');
    expect(sqlCalls[1]!.text).toContain('FROM auto_approval_policies');
    expect(sqlCalls[1]!.text).toContain('WHERE account_id = ?::uuid');
    expect(sqlCalls[1]!.text.indexOf('ORDER BY id'))
      .toBeLessThan(sqlCalls[1]!.text.indexOf('FOR UPDATE'));
    expect(sqlCalls[1]!.text).toContain('FOR UPDATE');
    expect(sqlCalls[2]!.text).toContain('FROM account_audit_log');
    expect(sqlCalls[2]!.text).toContain("event_type = 'autonomy_unsuspended'");
    expect(sqlCalls[2]!.text).toContain('created_at > ?');
    expect(sqlCalls[2]!.values).toEqual(['account-1', cutoff]);
  });

  it('rejects a disarmed candidate before reading audit history', async () => {
    sqlReturnQueue.push(
      mkTaggedResult([{ id: 'account-1' }]),
      mkTaggedResult([{
        location_id: null,
        persona: 'reply',
        action_class: 'posting',
        auto_approve_min_star: null,
        suspended_at: null,
      }]),
    );

    await expect(revalidateGovernorCandidate(
      mockSql as never,
      'account-1',
      new Date('2026-07-12T00:00:00.000Z'),
    )).resolves.toBe(false);
    expect(sqlCalls).toHaveLength(2);
  });

  it('rejects an armed override when the account-default is suspended', async () => {
    sqlReturnQueue.push(
      mkTaggedResult([{ id: 'account-1' }]),
      mkTaggedResult([
        {
          location_id: 'location-1',
          persona: 'reply',
          action_class: 'posting',
          auto_approve_min_star: 5,
          suspended_at: null,
        },
        {
          location_id: null,
          persona: 'reply',
          action_class: 'posting',
          auto_approve_min_star: null,
          suspended_at: new Date('2026-07-13T00:00:00.000Z'),
        },
      ]),
    );

    await expect(revalidateGovernorCandidate(
      mockSql as never,
      'account-1',
      new Date('2026-07-12T00:00:00.000Z'),
    )).resolves.toBe(false);
    expect(sqlCalls).toHaveLength(2);
  });

  it('rejects a candidate when an admin unsuspended after its observed cutoff', async () => {
    sqlReturnQueue.push(
      mkTaggedResult([{ id: 'account-1' }]),
      mkTaggedResult([{
        location_id: null,
        persona: 'reply',
        action_class: 'posting',
        auto_approve_min_star: 5,
        suspended_at: null,
      }]),
      mkTaggedResult([{ id: 'newer-unsuspend' }]),
    );

    await expect(revalidateGovernorCandidate(
      mockSql as never,
      'account-1',
      new Date('2026-07-12T00:00:00.000Z'),
    )).resolves.toBe(false);
  });
});
