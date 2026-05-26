import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockSql, mockCaptureAnalyticsEvent } = vi.hoisted(() => ({
  mockSql: vi.fn(),
  mockCaptureAnalyticsEvent: vi.fn(),
}));

vi.mock('../../../../src/lib/db/server', () => ({ sql: mockSql }));
vi.mock('../../../../src/lib/analytics/posthog', () => ({
  captureAnalyticsEvent: (...args: unknown[]) => mockCaptureAnalyticsEvent(...args),
}));

import { runAnalyticsDispatchOnce, startAnalyticsDispatchPoller, stopAnalyticsDispatchPoller } from '../AnalyticsDispatchPoller';

function sqlText(callIndex: number): string {
  return mockSql.mock.calls[callIndex]![0].join(' ');
}

function sqlValues(callIndex: number): unknown[] {
  return mockSql.mock.calls[callIndex]!.slice(1);
}

function row(overrides: Partial<{
  id: string;
  event_key: string;
  event_name: string;
  distinct_id: string;
  properties: Record<string, unknown> | string;
  attempts: number;
  max_attempts: number;
}> = {}) {
  return {
    id: 'evt-1',
    event_key: 'first_response_drafted:acct-1',
    event_name: 'first_response_drafted',
    distinct_id: 'acct-1',
    properties: { account_id: 'acct-1' },
    attempts: 1,
    max_attempts: 5,
    ...overrides,
  };
}

describe('AnalyticsDispatchPoller', () => {
  beforeEach(() => {
    delete process.env.ANALYTICS_DISPATCH_POLL_INTERVAL_MS;
    delete process.env.ANALYTICS_DISPATCH_BATCH_SIZE;
    mockSql.mockReset();
    mockCaptureAnalyticsEvent.mockReset();
    mockCaptureAnalyticsEvent.mockReturnValue(true);
  });

  afterEach(() => {
    stopAnalyticsDispatchPoller();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('dispatches pending analytics events and marks them completed', async () => {
    mockSql
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([row()])
      .mockResolvedValueOnce([]);

    await runAnalyticsDispatchOnce();

    expect(mockCaptureAnalyticsEvent).toHaveBeenCalledWith({
      event: 'first_response_drafted',
      distinctId: 'acct-1',
      properties: {
        account_id: 'acct-1',
        $insert_id: 'first_response_drafted:acct-1',
      },
    });
    expect(sqlText(2)).toContain("SET status = 'completed'");
  });

  it('runs stale dispatching recovery before claiming rows', async () => {
    mockSql
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    await runAnalyticsDispatchOnce();

    expect(sqlText(0)).toContain("SET status = 'pending'");
    expect(sqlText(0)).toContain("WHERE status = 'dispatching'");
    expect(sqlText(0)).toContain("locked_at < NOW() - INTERVAL '10 minutes'");
  });

  it('parses JSONB string properties and includes insert id', async () => {
    mockSql
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([row({ properties: '{"account_id":"acct-1","plan":"starter"}' })])
      .mockResolvedValueOnce([]);

    await runAnalyticsDispatchOnce();

    expect(mockCaptureAnalyticsEvent).toHaveBeenCalledWith({
      event: 'first_response_drafted',
      distinctId: 'acct-1',
      properties: {
        account_id: 'acct-1',
        plan: 'starter',
        $insert_id: 'first_response_drafted:acct-1',
      },
    });
  });

  it('uses pending failure path when capture returns false', async () => {
    mockCaptureAnalyticsEvent.mockReturnValue(false);
    mockSql
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([row({ attempts: 2, max_attempts: 5 })])
      .mockResolvedValueOnce([]);

    await runAnalyticsDispatchOnce();

    expect(sqlText(2)).not.toContain("SET status = 'completed'");
    expect(sqlText(2)).toContain('SET status = ');
    expect(sqlValues(2)).toContain('pending');
    expect(sqlValues(2)).toContain('posthog_not_configured');
  });

  it('uses failed path when capture throws on max attempt', async () => {
    mockCaptureAnalyticsEvent.mockImplementation(() => {
      throw new Error('posthog exploded');
    });
    mockSql
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([row({ attempts: 5, max_attempts: 5 })])
      .mockResolvedValueOnce([]);

    await runAnalyticsDispatchOnce();

    expect(sqlValues(2)).toContain('failed');
    expect(sqlValues(2)).toContain('posthog exploded');
  });

  it('guards final updates by dispatching status and attempt', async () => {
    mockSql
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([row({ attempts: 3 })])
      .mockResolvedValueOnce([]);

    await runAnalyticsDispatchOnce();

    expect(sqlText(2)).toContain("AND status = 'dispatching'");
    expect(sqlText(2)).toContain('AND attempts = ');
    expect(sqlValues(2)).toContain(3);
  });

  it('uses default batch size when env value is invalid', async () => {
    process.env.ANALYTICS_DISPATCH_BATCH_SIZE = 'not-a-number';
    mockSql
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    await runAnalyticsDispatchOnce();

    expect(sqlValues(1)).toContain(50);
  });

  it('clamps out-of-range batch sizes', async () => {
    process.env.ANALYTICS_DISPATCH_BATCH_SIZE = '999';
    mockSql
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    await runAnalyticsDispatchOnce();

    expect(sqlValues(1)).toContain(250);

    mockSql.mockReset();
    process.env.ANALYTICS_DISPATCH_BATCH_SIZE = '0';
    mockSql
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    await runAnalyticsDispatchOnce();

    expect(sqlValues(1)).toContain(1);
  });

  it('uses default poll interval when env value is invalid', () => {
    vi.useFakeTimers();
    process.env.ANALYTICS_DISPATCH_POLL_INTERVAL_MS = 'not-a-number';
    mockSql
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');

    startAnalyticsDispatchPoller();

    expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 30000);
  });
});
