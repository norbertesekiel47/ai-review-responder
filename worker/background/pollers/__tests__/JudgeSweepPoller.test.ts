import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockSql, sqlReturnQueue, sqlCalls, resetMockSql, mkTaggedResult, mockJudgeEnabled } =
  await vi.hoisted(async () => {
    const helpers = await import('../../../__tests__/helpers/mock-sql');
    return {
      ...helpers.createMockSql(),
      mkTaggedResult: helpers.mkTaggedResult,
      mockJudgeEnabled: vi.fn(() => false),
    };
  });

vi.mock('@/lib/db/server', () => ({ sql: mockSql }));
vi.mock('@/lib/responses/judge-flags', () => ({ judgeEnabled: mockJudgeEnabled }));

import { runJudgeSweepCycle } from '../JudgeSweepPoller';

describe('JudgeSweepPoller', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetMockSql();
    mockJudgeEnabled.mockReturnValue(false);
  });

  it('does no database work while the judge flag is off', async () => {
    await runJudgeSweepCycle(mockSql as never);

    expect(sqlCalls).toHaveLength(0);
  });

  it('scans the fixed bounded window and enqueues one deduplicated job per row', async () => {
    mockJudgeEnabled.mockReturnValue(true);
    sqlReturnQueue.push(
      mkTaggedResult([
        { response_id: 'response-1', business_id: 'business-1', account_id: 'account-1' },
        { response_id: 'response-2', business_id: 'business-2', account_id: 'account-2' },
      ]),
      mkTaggedResult([{}]),
      mkTaggedResult([{}]),
      mkTaggedResult([{}]),
    );

    await runJudgeSweepCycle(mockSql as never);

    expect(sqlCalls).toHaveLength(4);
    expect(sqlCalls[0]!.text).toContain('FROM responses r');
    expect(sqlCalls[0]!.text).toContain('LIMIT ?');
    expect(sqlCalls[0]!.values).toEqual(expect.arrayContaining([24, 50]));
    expect(mockSql.begin).toHaveBeenCalledTimes(2);
    expect(sqlCalls[1]!.values).toEqual(expect.arrayContaining([
      'judge_verdict',
      'response-1',
      { response_id: 'response-1', business_id: 'business-1', account_id: 'account-1' },
    ]));
    expect(sqlCalls[2]!.values).toEqual(expect.arrayContaining([
      'judge_verdict',
      'response-2',
      { response_id: 'response-2', business_id: 'business-2', account_id: 'account-2' },
    ]));
    // #949: the heartbeat is the LAST statement, after every enqueue landed.
    expect(sqlCalls[3]!.text).toContain('INSERT INTO poller_heartbeats');
    expect(sqlCalls[3]!.text).toContain('ON CONFLICT (poller_name) DO UPDATE');
    expect(sqlCalls[3]!.values).toEqual(['judge_sweep']);
  });

  // ── #949: heartbeat placement ─────────────────────────────────────────────
  // What the heartbeat MEANS is decided entirely by where it sits in the cycle,
  // so these three cases pin the position, not the statement.
  it('records a heartbeat on an idle cycle — an idle sweep is a working sweep', async () => {
    mockJudgeEnabled.mockReturnValue(true);
    sqlReturnQueue.push(mkTaggedResult([]), mkTaggedResult([{}]));

    await runJudgeSweepCycle(mockSql as never);

    // The probe must never confuse "no Judge work due" with "no Judge".
    expect(sqlCalls).toHaveLength(2);
    expect(sqlCalls[1]!.text).toContain('INSERT INTO poller_heartbeats');
  });

  it('records NO heartbeat when the cycle throws', async () => {
    mockJudgeEnabled.mockReturnValue(true);
    const scanError = new Error('database unavailable');
    const rejected = Promise.reject(scanError);
    rejected.catch(() => {});
    sqlReturnQueue.push(rejected);

    await expect(runJudgeSweepCycle(mockSql as never)).rejects.toBe(scanError);

    // A cycle that could not enqueue is not proof the Judge is being fed.
    // Recording one here would restore the exact blind spot #949 closes.
    expect(sqlCalls).toHaveLength(1);
    expect(sqlCalls.some((call) => call.text.includes('poller_heartbeats'))).toBe(false);
  });

  it('records NO heartbeat while the judge flag is off', async () => {
    await runJudgeSweepCycle(mockSql as never);

    // Deliberate: a heartbeat means a REAL judge cycle completed, never merely
    // that a timer fired. checkJudgeSweepLiveness gates on the same flag so a
    // switched-off Judge does not page in production.
    expect(sqlCalls).toHaveLength(0);
  });
});
