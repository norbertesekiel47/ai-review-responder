import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockSql, mockCaptureAnalyticsEvent } = vi.hoisted(() => ({
  mockSql: vi.fn(),
  mockCaptureAnalyticsEvent: vi.fn(),
}));

vi.mock('../../../../src/lib/db/server', () => ({ sql: mockSql }));
vi.mock('../../../../src/lib/analytics/posthog', () => ({
  captureAnalyticsEvent: (...args: unknown[]) => mockCaptureAnalyticsEvent(...args),
}));

import { runAnalyticsDispatchOnce } from '../AnalyticsDispatchPoller';

describe('AnalyticsDispatchPoller', () => {
  beforeEach(() => {
    mockSql.mockReset();
    mockCaptureAnalyticsEvent.mockReset();
  });

  it('dispatches pending analytics events and marks them completed', async () => {
    mockSql
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{
        id: 'evt-1',
        event_key: 'first_response_drafted:acct-1',
        event_name: 'first_response_drafted',
        distinct_id: 'acct-1',
        properties: { account_id: 'acct-1' },
        attempts: 1,
        max_attempts: 5,
      }])
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
    expect(mockSql.mock.calls[2]![0].join(' ')).toContain("SET status = 'completed'");
  });
});
