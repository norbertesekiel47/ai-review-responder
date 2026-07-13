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
    );

    await runJudgeSweepCycle(mockSql as never);

    expect(sqlCalls).toHaveLength(3);
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
  });
});
