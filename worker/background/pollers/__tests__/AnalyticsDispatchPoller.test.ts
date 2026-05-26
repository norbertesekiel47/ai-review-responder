import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockSql, mockCaptureAnalyticsEvent, mockFlushAnalytics, mockIsAnalyticsConfigured } =
  vi.hoisted(() => ({
    mockSql: vi.fn(),
    mockCaptureAnalyticsEvent: vi.fn(),
    mockFlushAnalytics: vi.fn(),
    mockIsAnalyticsConfigured: vi.fn(),
  }));

vi.mock('../../../../src/lib/db/server', () => ({ sql: mockSql }));
vi.mock('../../../../src/lib/analytics/posthog', () => ({
  captureAnalyticsEvent: (...args: unknown[]) => mockCaptureAnalyticsEvent(...args),
  flushAnalytics: (...args: unknown[]) => mockFlushAnalytics(...args),
  isAnalyticsConfigured: (...args: unknown[]) => mockIsAnalyticsConfigured(...args),
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
    mockFlushAnalytics.mockReset();
    mockFlushAnalytics.mockResolvedValue(undefined);
    mockIsAnalyticsConfigured.mockReset();
    mockIsAnalyticsConfigured.mockReturnValue(true);
  });

  afterEach(async () => {
    await stopAnalyticsDispatchPoller();
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

  it('skips dispatch entirely when PostHog is not configured', async () => {
    mockIsAnalyticsConfigured.mockReturnValue(false);

    await runAnalyticsDispatchOnce();

    // No claim, no capture — pending rows are preserved for when a key exists.
    expect(mockSql).not.toHaveBeenCalled();
    expect(mockCaptureAnalyticsEvent).not.toHaveBeenCalled();
  });

  it('flushes captured events before marking them completed', async () => {
    mockSql
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([row()])
      .mockResolvedValueOnce([]);

    await runAnalyticsDispatchOnce();

    expect(mockFlushAnalytics).toHaveBeenCalledTimes(1);
    // Completed UPDATE is the 3rd sql call; flush must precede it.
    expect(mockFlushAnalytics.mock.invocationCallOrder[0]!).toBeLessThan(
      mockSql.mock.invocationCallOrder[2]!,
    );
  });

  it('defers captured events without burning attempts when flush fails', async () => {
    mockFlushAnalytics.mockRejectedValueOnce(new Error('posthog network down'));
    mockSql
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([row({ attempts: 2 })])
      .mockResolvedValueOnce([]);

    await runAnalyticsDispatchOnce();

    expect(sqlText(2)).not.toContain("SET status = 'completed'");
    expect(sqlText(2)).toContain("status = 'pending'");
    expect(sqlText(2)).toContain('attempts = attempts - 1');
    expect(sqlValues(2).some((v) => typeof v === 'string' && v.includes('flush_failed'))).toBe(true);
  });

  it('runs stale dispatching recovery before claiming rows', async () => {
    mockSql
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    await runAnalyticsDispatchOnce();

    expect(sqlText(0)).toContain("SET status = 'pending'");
    expect(sqlText(0)).toContain("WHERE status = 'dispatching'");
    expect(sqlText(0)).toContain('locked_at IS NOT NULL');
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

  it('defers without burning attempts when capture returns false', async () => {
    mockCaptureAnalyticsEvent.mockReturnValue(false);
    mockSql
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([row({ attempts: 2, max_attempts: 5 })])
      .mockResolvedValueOnce([]);

    await runAnalyticsDispatchOnce();

    expect(sqlText(2)).not.toContain("SET status = 'completed'");
    expect(sqlText(2)).toContain("status = 'pending'");
    expect(sqlText(2)).toContain('attempts = attempts - 1');
    expect(sqlValues(2)).toContain('posthog_not_configured');
  });

  it('uses failed path with exponential backoff when capture throws on max attempt', async () => {
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
    expect(sqlText(2)).toContain('POWER(2,');
    expect(sqlText(2)).toContain('random()');
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

  it('awaits the in-flight dispatch run before stopping', async () => {
    let resolveClaim: ((rows: unknown[]) => void) | undefined;
    const claim = new Promise<unknown[]>((resolve) => {
      resolveClaim = resolve;
    });
    let completedCall = false;
    mockSql
      .mockResolvedValueOnce([]) // stale recovery
      .mockReturnValueOnce(claim) // claim (held open)
      .mockImplementationOnce(() => {
        completedCall = true;
        return Promise.resolve([]);
      });

    const runPromise = runAnalyticsDispatchOnce();
    const stopPromise = stopAnalyticsDispatchPoller();

    resolveClaim!([row()]);
    await stopPromise;

    // stop must not resolve until the in-flight run has marked the row completed.
    expect(completedCall).toBe(true);
    await runPromise;
  });

  it('uses default batch size when env value is invalid', async () => {
    process.env.ANALYTICS_DISPATCH_BATCH_SIZE = 'not-a-number';
    mockSql
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    await runAnalyticsDispatchOnce();

    expect(sqlValues(1)).toContain(50);
  });

  it('rejects a unit-suffixed batch size and uses the default', async () => {
    process.env.ANALYTICS_DISPATCH_BATCH_SIZE = '10rows';
    mockSql
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    await runAnalyticsDispatchOnce();

    expect(sqlValues(1)).toContain(50);
    expect(sqlValues(1)).not.toContain(10);
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

  it('rejects a unit-suffixed poll interval and uses the default', () => {
    vi.useFakeTimers();
    process.env.ANALYTICS_DISPATCH_POLL_INTERVAL_MS = '30s';
    mockSql
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');

    startAnalyticsDispatchPoller();

    expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 30000);
  });
});
