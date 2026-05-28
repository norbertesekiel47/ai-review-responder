import { beforeEach, describe, expect, it, vi } from 'vitest';

const { sqlReturnQueue, mockSql, mockCaptureAnalyticsEvent } = vi.hoisted(() => {
  const sqlReturnQueue: unknown[] = [];

  const mockSql: any = vi.fn((_strings: TemplateStringsArray, ..._values: unknown[]) => {
    const result = sqlReturnQueue.shift() ?? [];
    return Promise.resolve(result);
  });

  return {
    sqlReturnQueue,
    mockSql,
    mockCaptureAnalyticsEvent: vi.fn(() => true),
  };
});

vi.mock('../../../../src/lib/db/server', () => ({ sql: mockSql }));
vi.mock('../../../../src/lib/analytics/posthog', () => ({
  captureAnalyticsEvent: mockCaptureAnalyticsEvent,
}));

import { maybeCaptureActivationCompleted } from '../activation';

const INPUT = {
  responseId: '00000000-0000-0000-0000-000000000001',
  businessId: '00000000-0000-0000-0000-000000000002',
  reviewId: '00000000-0000-0000-0000-000000000003',
};

function activationRow(overrides: Record<string, unknown> = {}) {
  return {
    account_id: '00000000-0000-0000-0000-000000000004',
    account_created_at: new Date('2026-05-01T00:00:00.000Z'),
    response_id: INPUT.responseId,
    business_id: INPUT.businessId,
    review_id: INPUT.reviewId,
    posted_at: new Date('2026-05-03T12:00:00.000Z'),
    first_response_id: INPUT.responseId,
    ...overrides,
  };
}

describe('maybeCaptureActivationCompleted', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sqlReturnQueue.length = 0;
    mockCaptureAnalyticsEvent.mockReturnValue(true);
  });

  it('captures activation_completed for the first posted response within 7 days', async () => {
    sqlReturnQueue.push([activationRow()]);

    await maybeCaptureActivationCompleted(INPUT);

    expect(mockCaptureAnalyticsEvent).toHaveBeenCalledWith({
      event: 'activation_completed',
      distinctId: '00000000-0000-0000-0000-000000000004',
      uuid: INPUT.responseId,
      properties: {
        account_id: '00000000-0000-0000-0000-000000000004',
        business_id: INPUT.businessId,
        response_id: INPUT.responseId,
        review_id: INPUT.reviewId,
        days_to_activation: 2.5,
      },
    });

    const query = (mockSql.mock.calls[0]![0] as TemplateStringsArray).join('?');
    expect(query).toContain('JOIN LATERAL');
    expect(query).toContain("r2.status = 'posted'");
    expect(query).toContain('ORDER BY r2.posted_at ASC, r2.id ASC');
    expect(query).toContain('LIMIT 1');
  });

  it('skips when the current posted response is not the account first', async () => {
    sqlReturnQueue.push([
      activationRow({ first_response_id: '00000000-0000-0000-0000-000000000099' }),
    ]);

    await maybeCaptureActivationCompleted(INPUT);

    expect(mockCaptureAnalyticsEvent).not.toHaveBeenCalled();
  });

  it('skips when the first post is outside the 7-day activation window', async () => {
    sqlReturnQueue.push([
      activationRow({ posted_at: new Date('2026-05-08T00:00:01.000Z') }),
    ]);

    await maybeCaptureActivationCompleted(INPUT);

    expect(mockCaptureAnalyticsEvent).not.toHaveBeenCalled();
  });

  it('logs and suppresses analytics capture errors', async () => {
    const logger = { warn: vi.fn() };
    sqlReturnQueue.push([activationRow()]);
    mockCaptureAnalyticsEvent.mockImplementation(() => {
      throw new Error('posthog unavailable');
    });

    await expect(
      maybeCaptureActivationCompleted({ ...INPUT, logger }),
    ).resolves.toBeUndefined();

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('activation_completed capture failed'),
    );
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining(INPUT.responseId));
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('posthog unavailable'));
  });

  it('does not throw or capture when SQL returns no row', async () => {
    sqlReturnQueue.push([]);

    await expect(maybeCaptureActivationCompleted(INPUT)).resolves.toBeUndefined();

    expect(mockCaptureAnalyticsEvent).not.toHaveBeenCalled();
  });

  it('skips and warns when the row review_id does not match the input contract', async () => {
    const logger = { warn: vi.fn() };
    sqlReturnQueue.push([
      activationRow({ review_id: '00000000-0000-0000-0000-0000000000ff' }),
    ]);

    await maybeCaptureActivationCompleted({ ...INPUT, logger });

    expect(mockCaptureAnalyticsEvent).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('reviewId mismatch'),
    );
  });
});
