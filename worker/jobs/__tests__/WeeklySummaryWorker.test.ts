import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Job } from 'bullmq';
import type { WeeklySummaryPayload } from '../../../src/lib/shared/worker-types';

// ── Hoisted mock state ───────────────────────────────────────────────
const {
  sqlReturnQueue,
  mockSql,
  mockMarkOutboxCompleted,
  mockMarkOutboxFailed,
  mockSendInternalEmail,
  mockBuildWeeklyValueReportHtml,
  mockRecordNotificationDelivery,
  mockGenerateReviewSummary,
} = vi.hoisted(() => {
  const sqlReturnQueue: unknown[] = [];

  const mockSql: any = vi.fn((_s: TemplateStringsArray, ..._v: unknown[]) => {
    const result = sqlReturnQueue.shift() ?? [];
    return Promise.resolve(result);
  });

  mockSql.begin = vi.fn(async (cb: (tx: any) => Promise<any>) => cb(mockSql));

  return {
    sqlReturnQueue,
    mockSql,
    mockMarkOutboxCompleted: vi.fn(),
    mockMarkOutboxFailed: vi.fn(),
    mockSendInternalEmail: vi.fn().mockResolvedValue({ messageId: 'msg-ws-1' }),
    mockBuildWeeklyValueReportHtml: vi.fn((_params: Record<string, unknown>) => '<html>value-report</html>'),
    mockRecordNotificationDelivery: vi.fn(),
    mockGenerateReviewSummary: vi.fn().mockResolvedValue({
      summaryText: 'AI summary of reviews',
      provider: 'mock' as const,
      costUsd: 0,
    }),
  };
});

vi.mock('../../../src/lib/db/server', () => ({ sql: mockSql, jsonb: (v: unknown) => v }));
vi.mock('../../../src/lib/shared/outbox', () => ({
  markOutboxCompleted: mockMarkOutboxCompleted,
  markOutboxFailed: mockMarkOutboxFailed,
  extractOutboxHandle: (d: any, fallback: string) => ({ outboxId: (d && typeof d.outbox_id === 'string') ? d.outbox_id : fallback, attempt: (d && typeof d.outbox_attempt === 'number') ? d.outbox_attempt : undefined }),
}));
vi.mock('../../../src/lib/notifications/email', () => ({
  sendInternalEmail: mockSendInternalEmail,
  buildWeeklyValueReportHtml: mockBuildWeeklyValueReportHtml,
}));
vi.mock('../../../src/lib/notifications/delivery', () => ({
  recordNotificationDelivery: mockRecordNotificationDelivery,
}));
vi.mock('../../../src/lib/responses/review-summary', () => ({
  generateReviewSummary: mockGenerateReviewSummary,
}));
vi.mock('uuid', () => ({ v7: vi.fn(() => 'test-uuid') }));

import { handleWeeklySummary } from '../WeeklySummaryWorker';

function makeJob(overrides: Partial<WeeklySummaryPayload> = {}): Job<WeeklySummaryPayload> {
  return {
    data: {
      business_id: 'biz-1',
      week_start_date: '2026-04-06',
      ...overrides,
    },
    id: 'outbox-ws-1',
  } as Job<WeeklySummaryPayload>;
}

function mockBusinessRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'biz-1',
    name: 'Test Biz',
    owner_email: 'owner@test.com',
    subscription_status: 'active',
    updated_at: new Date(),
    initial_review_count: 50,
    initial_responded_count: 10,
    baseline_captured_at: new Date('2026-01-01'),
    subscription_tier: 'standard',
    ...overrides,
  };
}

/**
 * Pushes the standard SQL return sequence for a full happy-path run.
 *
 * Query order:
 *  1. business SELECT
 *  2. review count
 *  3. responded count
 *  4. notable reviews
 *  5. reviews for summary (intelligence brief)
 *  6. 4-week avg
 *  7. latest ranking snapshot
 *  8. initial ranking snapshot (only if latest exists)
 *  9. dashboard eligibility (users with auth_id)
 * 10. upsert RETURNING
 * 11. claim UPDATE (claimed_at = NOW() WHERE claimed_at IS NULL AND sent_at IS NULL)
 * 12. UPDATE summary_text (only if LLM called)
 * 13. UPDATE sent_at (always, before email send)
 */
function pushHappyPathSqlQueue(opts: {
  business?: Record<string, unknown>;
  reviewsForSummary?: unknown[];
  latestRanking?: unknown[];
  initialRanking?: unknown[];
  ownerWithAuth?: unknown[];
  upsertRow?: unknown[];
  summaryText?: string | null;
} = {}) {
  const biz = opts.business ?? {};
  sqlReturnQueue.push([mockBusinessRow(biz)]);                              // 1. business
  sqlReturnQueue.push([{ count: '5' }]);                                    // 2. review count
  sqlReturnQueue.push([{ count: '4' }]);                                    // 3. responded count
  sqlReturnQueue.push([{ reviewer_name: 'Jane', star_rating: 1, review_text: 'Bad' }]); // 4. notable
  sqlReturnQueue.push(opts.reviewsForSummary ?? [                           // 5. reviews for summary
    { star_rating: 5, review_text: 'Great service' },
    { star_rating: 3, review_text: 'Okay' },
  ]);
  sqlReturnQueue.push([{ avg: '4.5' }]);                                    // 6. 4-week avg
  sqlReturnQueue.push(opts.latestRanking ?? []);                            // 7. latest ranking
  if (opts.latestRanking && opts.latestRanking.length > 0) {
    sqlReturnQueue.push(opts.initialRanking ?? [{ rank_position: 8 }]);     // 8. initial ranking
  }
  sqlReturnQueue.push(opts.ownerWithAuth ?? []);                            // 9. dashboard eligibility
  sqlReturnQueue.push(opts.upsertRow ?? [{ sent_at: null, summary_text: opts.summaryText ?? null }]); // 10. upsert
  sqlReturnQueue.push([{ id: 'claimed-id' }]);                              // 11. claim UPDATE
  // 12. UPDATE summary_text — only if LLM is called (summaryText is null and reviews exist)
  if (!opts.summaryText && (opts.reviewsForSummary === undefined || opts.reviewsForSummary.length > 0)) {
    sqlReturnQueue.push([]);                                                // 12. UPDATE summary_text
  }
  sqlReturnQueue.push([]);                                                  // 13. UPDATE sent_at
}

describe('WeeklySummaryWorker – handleWeeklySummary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sqlReturnQueue.length = 0;
    process.env.RESEND_FROM_EMAIL = 'RepWorth <test@test.com>';
    process.env.NEXT_PUBLIC_APP_URL = 'https://app.repworth.com';
  });

  it('skips if business not found', async () => {
    sqlReturnQueue.push([]);

    await handleWeeklySummary(makeJob());

    expect(mockMarkOutboxFailed).toHaveBeenCalledWith('outbox-ws-1', 'business_not_found', undefined);
    expect(mockSendInternalEmail).not.toHaveBeenCalled();
  });

  it('skips if subscription not allowed (cancelled)', async () => {
    sqlReturnQueue.push([mockBusinessRow({ subscription_status: 'cancelled' })]);

    await handleWeeklySummary(makeJob());

    expect(mockSendInternalEmail).not.toHaveBeenCalled();
    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith('outbox-ws-1', undefined);
  });

  it('skips if subscription not allowed (pending_payment)', async () => {
    sqlReturnQueue.push([mockBusinessRow({ subscription_status: 'pending_payment' })]);

    await handleWeeklySummary(makeJob());

    expect(mockSendInternalEmail).not.toHaveBeenCalled();
    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith('outbox-ws-1', undefined);
  });

  it('calls generateReviewSummary with week reviews', async () => {
    const reviews = [
      { star_rating: 5, review_text: 'Excellent!' },
      { star_rating: 2, review_text: 'Could be better' },
    ];
    pushHappyPathSqlQueue({ reviewsForSummary: reviews });

    await handleWeeklySummary(makeJob());

    expect(mockGenerateReviewSummary).toHaveBeenCalledOnce();
    expect(mockGenerateReviewSummary).toHaveBeenCalledWith(
      [
        { starRating: 5, reviewText: 'Excellent!' },
        { starRating: 2, reviewText: 'Could be better' },
      ],
      'biz-1',
      'standard',
    );
  });

  it('uses buildWeeklyValueReportHtml (not old template)', async () => {
    pushHappyPathSqlQueue();

    await handleWeeklySummary(makeJob());

    expect(mockBuildWeeklyValueReportHtml).toHaveBeenCalledOnce();
    const params = mockBuildWeeklyValueReportHtml.mock.calls[0]![0];
    expect(params.businessName).toBe('Test Biz');
    expect(params.totalReviews).toBe(5);
    expect(params.totalResponded).toBe(4);
    expect(params.fourWeekAvgReviews).toBe(4.5);
    expect(params.intelligenceBrief).toBe('AI summary of reviews');
    expect(params.baselineResponseRate).toBe(20); // 10/50 * 100
  });

  it('records notification delivery with template=weekly_value_report', async () => {
    pushHappyPathSqlQueue();

    await handleWeeklySummary(makeJob());

    expect(mockRecordNotificationDelivery).toHaveBeenCalledOnce();
    expect(mockRecordNotificationDelivery).toHaveBeenCalledWith({
      businessId: 'biz-1',
      channel: 'email',
      recipient: 'owner@test.com',
      template: 'weekly_value_report',
      externalMessageId: 'msg-ws-1',
    });
    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith('outbox-ws-1', undefined);
  });

  it('reuses existing summary_text instead of calling LLM again', async () => {
    pushHappyPathSqlQueue({ summaryText: 'Previously generated summary' });

    await handleWeeklySummary(makeJob());

    expect(mockGenerateReviewSummary).not.toHaveBeenCalled();
    const params = mockBuildWeeklyValueReportHtml.mock.calls[0]![0];
    expect(params.intelligenceBrief).toBe('Previously generated summary');
  });

  it('skips intelligence brief when no reviews this week', async () => {
    pushHappyPathSqlQueue({ reviewsForSummary: [] });

    await handleWeeklySummary(makeJob());

    expect(mockGenerateReviewSummary).not.toHaveBeenCalled();
    const params = mockBuildWeeklyValueReportHtml.mock.calls[0]![0];
    expect(params.intelligenceBrief).toBeNull();
  });

  it('already-sent summary marks outbox completed without sending', async () => {
    sqlReturnQueue.push([mockBusinessRow()]);      // business
    sqlReturnQueue.push([{ count: '3' }]);          // review count
    sqlReturnQueue.push([{ count: '3' }]);          // responded count
    sqlReturnQueue.push([]);                         // notable
    sqlReturnQueue.push([]);                         // reviews for summary
    sqlReturnQueue.push([{ avg: '3.0' }]);           // 4-week avg
    sqlReturnQueue.push([]);                         // latest ranking
    sqlReturnQueue.push([]);                         // dashboard eligibility
    sqlReturnQueue.push([]);                         // upsert returns empty
    sqlReturnQueue.push([{ sent_at: '2026-04-07', claimed_at: '2026-04-07' }]); // distinguish query: sent_at IS NOT NULL

    await handleWeeklySummary(makeJob());

    expect(mockSendInternalEmail).not.toHaveBeenCalled();
    expect(mockGenerateReviewSummary).not.toHaveBeenCalled();
    expect(mockRecordNotificationDelivery).not.toHaveBeenCalled();
    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith('outbox-ws-1', undefined);
  });

  it('throws for retry when claimed by another worker (not yet sent)', async () => {
    sqlReturnQueue.push([mockBusinessRow()]);      // business
    sqlReturnQueue.push([{ count: '3' }]);          // review count
    sqlReturnQueue.push([{ count: '3' }]);          // responded count
    sqlReturnQueue.push([]);                         // notable
    sqlReturnQueue.push([]);                         // reviews for summary
    sqlReturnQueue.push([{ avg: '3.0' }]);           // 4-week avg
    sqlReturnQueue.push([]);                         // latest ranking
    sqlReturnQueue.push([]);                         // dashboard eligibility
    sqlReturnQueue.push([]);                         // upsert returns empty
    sqlReturnQueue.push([{ sent_at: null, claimed_at: new Date().toISOString() }]); // distinguish: claimed but not sent

    await expect(handleWeeklySummary(makeJob())).rejects.toThrow('Report claimed by another worker');
    expect(mockSendInternalEmail).not.toHaveBeenCalled();
    expect(mockMarkOutboxCompleted).not.toHaveBeenCalled();
  });

  it('includes ranking data when snapshots exist', async () => {
    pushHappyPathSqlQueue({
      latestRanking: [{ keyword: 'pizza near me', rank_position: 3 }],
      initialRanking: [{ rank_position: 8 }],
    });

    await handleWeeklySummary(makeJob());

    const params = mockBuildWeeklyValueReportHtml.mock.calls[0]![0];
    expect(params.ranking).toEqual({
      keyword: 'pizza near me',
      currentRank: 3,
      initialRank: 8,
    });
  });

  it('includes dashboard URL when owner has auth_id', async () => {
    pushHappyPathSqlQueue({
      ownerWithAuth: [{ exists: 1 }],
    });

    await handleWeeklySummary(makeJob());

    const params = mockBuildWeeklyValueReportHtml.mock.calls[0]![0];
    expect(params.dashboardUrl).toBe('https://app.repworth.com/dashboard');
  });

  it('sets baselineResponseRate to null when no baseline captured', async () => {
    pushHappyPathSqlQueue({
      business: { baseline_captured_at: null, initial_review_count: null, initial_responded_count: null },
    });

    await handleWeeklySummary(makeJob());

    const params = mockBuildWeeklyValueReportHtml.mock.calls[0]![0];
    expect(params.baselineResponseRate).toBeNull();
  });

  it('sends email with Weekly Value Report subject', async () => {
    pushHappyPathSqlQueue();

    await handleWeeklySummary(makeJob());

    expect(mockSendInternalEmail).toHaveBeenCalledOnce();
    const emailArgs = mockSendInternalEmail.mock.calls[0]![0];
    expect(emailArgs.subject).toContain('Weekly Value Report');
    expect(emailArgs.subject).toContain('Test Biz');
  });

  it('fails outbox on email send error', async () => {
    pushHappyPathSqlQueue();
    mockSendInternalEmail.mockRejectedValueOnce(new Error('Resend API error'));

    await handleWeeklySummary(makeJob());

    expect(mockMarkOutboxFailed).toHaveBeenCalledWith('outbox-ws-1', 'Resend API error', undefined);
    expect(mockRecordNotificationDelivery).not.toHaveBeenCalled();
  });
});
