import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Job } from 'bullmq';
import type { SendMonthlyImpactPayload } from '../../src/lib/shared/worker-types';

// ── Hoisted mock state ───────────────────────────────────────────────
const {
  sqlReturnQueue,
  mockSql,
  mockMarkOutboxCompleted,
  mockMarkOutboxFailed,
  mockSendInternalEmail,
  mockBuildMonthlyImpactEmailHtml,
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
    mockSendInternalEmail: vi.fn().mockResolvedValue({ messageId: 'msg-mi-1' }),
    mockBuildMonthlyImpactEmailHtml: vi.fn((_params: Record<string, unknown>) => '<html>monthly-impact</html>'),
    mockRecordNotificationDelivery: vi.fn(),
    mockGenerateReviewSummary: vi.fn().mockResolvedValue({
      summaryText: 'AI monthly summary',
      provider: 'mock' as const,
      costUsd: 0,
    }),
  };
});

vi.mock('../../src/lib/db/server', () => ({ sql: mockSql, jsonb: (v: unknown) => v }));
vi.mock('../../src/lib/shared/outbox', () => ({
  markOutboxCompleted: mockMarkOutboxCompleted,
  markOutboxFailed: mockMarkOutboxFailed,
}));
vi.mock('../../src/lib/notifications/email', () => ({
  sendInternalEmail: mockSendInternalEmail,
  buildMonthlyImpactEmailHtml: mockBuildMonthlyImpactEmailHtml,
}));
vi.mock('../../src/lib/notifications/delivery', () => ({
  recordNotificationDelivery: mockRecordNotificationDelivery,
}));
vi.mock('../../src/lib/responses/review-summary', () => ({
  generateReviewSummary: mockGenerateReviewSummary,
}));
vi.mock('uuid', () => ({ v7: vi.fn(() => 'test-uuid') }));

import { handleMonthlyImpact } from '../jobs/MonthlyImpactWorker';

function makeJob(overrides: Partial<SendMonthlyImpactPayload> = {}): Job<SendMonthlyImpactPayload> {
  return {
    data: {
      business_id: 'biz-1',
      month_start_date: '2026-03-01',
      ...overrides,
    },
    id: 'outbox-mi-1',
  } as Job<SendMonthlyImpactPayload>;
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
 *  2. upsert RETURNING
 *  3. claim UPDATE (claimed_at = NOW() WHERE claimed_at IS NULL AND sent_at IS NULL)
 *  4. review count
 *  5. responded count
 *  6. best review of month
 *  7. reviews for summary (intelligence brief) — only if summary_text is null
 *  8. UPDATE summary_text — only if LLM called and returned text
 *  9. latest ranking snapshot
 * 10. initial ranking snapshot — only if latest exists
 * 11. dashboard eligibility (users with auth_id)
 * 12. UPDATE sent_at (always, before email send)
 */
function pushHappyPathSqlQueue(opts: {
  business?: Record<string, unknown>;
  upsertRow?: unknown[];
  summaryText?: string | null;
  bestReview?: unknown[];
  reviewsForSummary?: unknown[];
  latestRanking?: unknown[];
  initialRanking?: unknown[];
  ownerWithAuth?: unknown[];
} = {}) {
  const biz = opts.business ?? {};
  sqlReturnQueue.push([mockBusinessRow(biz)]);                            // 1. business
  sqlReturnQueue.push(opts.upsertRow ?? [{ sent_at: null, summary_text: opts.summaryText ?? null }]); // 2. upsert
  sqlReturnQueue.push([{ id: 'claimed-id' }]);                             // 3. claim UPDATE
  sqlReturnQueue.push([{ count: '12' }]);                                  // 4. review count
  sqlReturnQueue.push([{ count: '10' }]);                                  // 5. responded count
  sqlReturnQueue.push(opts.bestReview ?? [{                               // 6. best review
    reviewer_name: 'Alice',
    star_rating: 5,
    review_text: 'Amazing place!',
    response_text: 'Thank you Alice!',
  }]);

  // 7. reviews for summary — only queried if summary_text is null
  if (!opts.summaryText) {
    sqlReturnQueue.push(opts.reviewsForSummary ?? [
      { star_rating: 5, review_text: 'Great service' },
      { star_rating: 4, review_text: 'Very good' },
    ]);
    // 8. UPDATE summary_text — only if reviews exist and LLM returned text
    const hasReviews = opts.reviewsForSummary === undefined || opts.reviewsForSummary.length > 0;
    if (hasReviews) {
      sqlReturnQueue.push([]);                                             // 8. UPDATE summary_text
    }
  }

  sqlReturnQueue.push(opts.latestRanking ?? []);                           // 9. latest ranking
  if (opts.latestRanking && opts.latestRanking.length > 0) {
    sqlReturnQueue.push(opts.initialRanking ?? [{ rank_position: 8 }]);   // 10. initial ranking
  }
  sqlReturnQueue.push(opts.ownerWithAuth ?? []);                           // 11. dashboard eligibility
  sqlReturnQueue.push([]);                                                  // 12. UPDATE sent_at
}

describe('MonthlyImpactWorker – handleMonthlyImpact', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sqlReturnQueue.length = 0;
    process.env.RESEND_FROM_EMAIL = 'RepWorth <test@test.com>';
    process.env.NEXT_PUBLIC_APP_URL = 'https://app.repworth.com';
  });

  it('fails outbox if business not found', async () => {
    sqlReturnQueue.push([]);

    await handleMonthlyImpact(makeJob());

    expect(mockMarkOutboxFailed).toHaveBeenCalledWith('outbox-mi-1', 'business_not_found');
    expect(mockSendInternalEmail).not.toHaveBeenCalled();
  });

  it('skips if subscription not allowed (cancelled)', async () => {
    sqlReturnQueue.push([mockBusinessRow({ subscription_status: 'cancelled' })]);

    await handleMonthlyImpact(makeJob());

    expect(mockSendInternalEmail).not.toHaveBeenCalled();
    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith('outbox-mi-1');
  });

  it('skips if subscription not allowed (pending_payment)', async () => {
    sqlReturnQueue.push([mockBusinessRow({ subscription_status: 'pending_payment' })]);

    await handleMonthlyImpact(makeJob());

    expect(mockSendInternalEmail).not.toHaveBeenCalled();
    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith('outbox-mi-1');
  });

  it('already-sent report marks outbox completed without sending', async () => {
    sqlReturnQueue.push([mockBusinessRow()]);   // business
    sqlReturnQueue.push([]);                     // upsert returns empty
    sqlReturnQueue.push([{ sent_at: '2026-03-01', claimed_at: '2026-03-01' }]); // distinguish: sent_at IS NOT NULL

    await handleMonthlyImpact(makeJob());

    expect(mockSendInternalEmail).not.toHaveBeenCalled();
    expect(mockGenerateReviewSummary).not.toHaveBeenCalled();
    expect(mockRecordNotificationDelivery).not.toHaveBeenCalled();
    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith('outbox-mi-1');
  });

  it('throws for retry when claimed by another worker (not yet sent)', async () => {
    sqlReturnQueue.push([mockBusinessRow()]);   // business
    sqlReturnQueue.push([]);                     // upsert returns empty
    sqlReturnQueue.push([{ sent_at: null, claimed_at: new Date().toISOString() }]); // claimed but not sent

    await expect(handleMonthlyImpact(makeJob())).rejects.toThrow('Report claimed by another worker');
    expect(mockSendInternalEmail).not.toHaveBeenCalled();
    expect(mockMarkOutboxCompleted).not.toHaveBeenCalled();
  });

  it('sends email and records delivery on success', async () => {
    pushHappyPathSqlQueue();

    await handleMonthlyImpact(makeJob());

    expect(mockBuildMonthlyImpactEmailHtml).toHaveBeenCalledOnce();
    const params = mockBuildMonthlyImpactEmailHtml.mock.calls[0]![0];
    expect(params.businessName).toBe('Test Biz');
    expect(params.monthLabel).toBe('March 2026');
    expect(params.totalReviews).toBe(12);
    expect(params.totalResponded).toBe(10);
    expect(params.responseRate).toBe(83); // Math.round(10/12 * 100)
    expect(params.baselineResponseRate).toBe(20); // 10/50 * 100
    expect(params.timeSavedMinutes).toBe(70); // 10 * 7
    expect(params.intelligenceBrief).toBe('AI monthly summary');
    expect(params.bestReview).toEqual({
      reviewerName: 'Alice',
      starRating: 5,
      reviewText: 'Amazing place!',
      responseText: 'Thank you Alice!',
    });

    expect(mockSendInternalEmail).toHaveBeenCalledOnce();
    const emailArgs = mockSendInternalEmail.mock.calls[0]![0];
    expect(emailArgs.subject).toBe('Monthly Impact Report — Test Biz (March 2026)');
    expect(emailArgs.to).toBe('owner@test.com');

    expect(mockRecordNotificationDelivery).toHaveBeenCalledWith({
      businessId: 'biz-1',
      channel: 'email',
      recipient: 'owner@test.com',
      template: 'monthly_impact',
      externalMessageId: 'msg-mi-1',
    });
    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith('outbox-mi-1');
  });

  it('reuses existing summary_text from upsert (no LLM re-call)', async () => {
    pushHappyPathSqlQueue({ summaryText: 'Previously generated monthly summary' });

    await handleMonthlyImpact(makeJob());

    expect(mockGenerateReviewSummary).not.toHaveBeenCalled();
    const params = mockBuildMonthlyImpactEmailHtml.mock.calls[0]![0];
    expect(params.intelligenceBrief).toBe('Previously generated monthly summary');
  });

  it('skips intelligence brief when no reviews have text', async () => {
    pushHappyPathSqlQueue({ reviewsForSummary: [] });

    await handleMonthlyImpact(makeJob());

    expect(mockGenerateReviewSummary).not.toHaveBeenCalled();
    const params = mockBuildMonthlyImpactEmailHtml.mock.calls[0]![0];
    expect(params.intelligenceBrief).toBeNull();
  });

  it('includes ranking data when snapshots exist', async () => {
    pushHappyPathSqlQueue({
      latestRanking: [{ keyword: 'dentist downtown', rank_position: 2 }],
      initialRanking: [{ rank_position: 7 }],
    });

    await handleMonthlyImpact(makeJob());

    const params = mockBuildMonthlyImpactEmailHtml.mock.calls[0]![0];
    expect(params.ranking).toEqual({
      keyword: 'dentist downtown',
      currentRank: 2,
      initialRank: 7,
    });
  });

  it('includes dashboard URL when owner has auth_id', async () => {
    pushHappyPathSqlQueue({ ownerWithAuth: [{ exists: 1 }] });

    await handleMonthlyImpact(makeJob());

    const params = mockBuildMonthlyImpactEmailHtml.mock.calls[0]![0];
    expect(params.dashboardUrl).toBe('https://app.repworth.com/dashboard');
  });

  it('sets baselineResponseRate to null when no baseline captured', async () => {
    pushHappyPathSqlQueue({
      business: { baseline_captured_at: null, initial_review_count: null, initial_responded_count: null },
    });

    await handleMonthlyImpact(makeJob());

    const params = mockBuildMonthlyImpactEmailHtml.mock.calls[0]![0];
    expect(params.baselineResponseRate).toBeNull();
  });

  it('fails outbox on email send error', async () => {
    pushHappyPathSqlQueue();
    mockSendInternalEmail.mockRejectedValueOnce(new Error('Resend API error'));

    await handleMonthlyImpact(makeJob());

    expect(mockMarkOutboxFailed).toHaveBeenCalledWith('outbox-mi-1', 'Resend API error');
    expect(mockRecordNotificationDelivery).not.toHaveBeenCalled();
  });

  it('handles best review with no response text', async () => {
    pushHappyPathSqlQueue({
      bestReview: [{
        reviewer_name: 'Bob',
        star_rating: 4,
        review_text: 'Good stuff',
        response_text: null,
      }],
    });

    await handleMonthlyImpact(makeJob());

    const params = mockBuildMonthlyImpactEmailHtml.mock.calls[0]![0];
    expect(params.bestReview).toEqual({
      reviewerName: 'Bob',
      starRating: 4,
      reviewText: 'Good stuff',
      responseText: null,
    });
  });

  it('handles no best review (no 4+ star reviews)', async () => {
    pushHappyPathSqlQueue({ bestReview: [] });

    await handleMonthlyImpact(makeJob());

    const params = mockBuildMonthlyImpactEmailHtml.mock.calls[0]![0];
    expect(params.bestReview).toBeNull();
  });
});
