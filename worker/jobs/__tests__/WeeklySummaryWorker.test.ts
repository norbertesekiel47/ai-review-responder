import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Job } from 'bullmq';
import type { WeeklySummaryPayload } from '../../../src/lib/shared/worker-types';

// ── Hoisted mock state ───────────────────────────────────────────────
const {
  sqlReturnQueue,
  sqlCalls,
  transactionEvents,
  spineTxStates,
  mockSql,
  mockMarkOutboxCompleted,
  mockMarkOutboxFailed,
  mockSendInternalEmail,
  mockBuildWeeklyValueReportHtml,
  mockRecordNotificationDelivery,
  mockGenerateReviewSummary,
  mockStartOrGetActiveRun,
  mockRecordStep,
  mockRecordOutcome,
  mockCompleteRun,
} = vi.hoisted(() => {
  const sqlReturnQueue: unknown[] = [];
  const sqlCalls: { text: string; values: unknown[]; inTransaction: boolean }[] = [];
  const transactionEvents: string[] = [];
  const spineTxStates: { operation: string; inTransaction: boolean; tx: unknown }[] = [];
  let inTransaction = false;

  const mockSql: any = vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join('?');
    sqlCalls.push({ text, values, inTransaction });
    if (text.includes('SET sent_at = NOW()')) transactionEvents.push('sent_at_flip');
    const result = sqlReturnQueue.shift() ?? [];
    return Promise.resolve(result);
  });

  mockSql.begin = vi.fn(async (cb: (tx: any) => Promise<any>) => {
    inTransaction = true;
    try {
      return await cb(mockSql);
    } finally {
      inTransaction = false;
    }
  });

  const spineMock = (operation: string) => vi.fn(async (tx: unknown) => {
    transactionEvents.push(operation);
    spineTxStates.push({ operation, inTransaction, tx });
  });
  const mockStartOrGetActiveRun = vi.fn(async (tx: unknown) => {
    transactionEvents.push('start_run');
    spineTxStates.push({ operation: 'start_run', inTransaction, tx });
    return { runId: 'run-weekly-1', created: true };
  });

  return {
    sqlReturnQueue,
    sqlCalls,
    transactionEvents,
    spineTxStates,
    mockSql,
    mockMarkOutboxCompleted: vi.fn(),
    mockMarkOutboxFailed: vi.fn(),
    mockSendInternalEmail: vi.fn(async (_input: Record<string, unknown>) => {
      transactionEvents.push('send_email');
      return { messageId: 'msg-ws-1' };
    }),
    mockBuildWeeklyValueReportHtml: vi.fn((_params: Record<string, unknown>) => '<html>value-report</html>'),
    mockRecordNotificationDelivery: vi.fn(),
    mockGenerateReviewSummary: vi.fn().mockResolvedValue({
      summaryText: 'AI summary of reviews',
      provider: 'mock' as const,
      costUsd: 0,
    }),
    mockStartOrGetActiveRun,
    mockRecordStep: spineMock('record_step'),
    mockRecordOutcome: spineMock('record_outcome'),
    mockCompleteRun: spineMock('complete_run'),
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
vi.mock('../../../src/lib/agents/run-spine', () => ({
  startOrGetActiveRun: mockStartOrGetActiveRun,
  recordStep: mockRecordStep,
  recordOutcome: mockRecordOutcome,
  completeRun: mockCompleteRun,
}));
vi.mock('uuid', () => ({ v7: vi.fn(() => 'test-uuid') }));

import { handleWeeklySummary } from '../WeeklySummaryWorker';
import { makeSummaryReportBusiness } from './summary-report-fixtures';
import type { SummaryReportBusiness } from '../summary-report-helpers';

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
  business?: Partial<SummaryReportBusiness>;
  reviewsForSummary?: unknown[];
  latestRanking?: unknown[];
  initialRanking?: unknown[];
  ownerWithAuth?: unknown[];
  upsertRow?: unknown[];
  summaryText?: string | null;
  sentFlipRow?: unknown[];
} = {}) {
  sqlReturnQueue.push([makeSummaryReportBusiness(opts.business)]);          // 1. business
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
  sqlReturnQueue.push(opts.sentFlipRow ?? [{ id: 'claimed-id' }]);          // 13. guarded UPDATE sent_at
}

describe('WeeklySummaryWorker – handleWeeklySummary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sqlReturnQueue.length = 0;
    sqlCalls.length = 0;
    transactionEvents.length = 0;
    spineTxStates.length = 0;
    process.env.RESEND_FROM_EMAIL = 'RepWorth <test@test.com>';
    process.env.NEXT_PUBLIC_APP_URL = 'https://app.repworth.com';
  });

  it('skips if business not found', async () => {
    sqlReturnQueue.push([]);

    await handleWeeklySummary(makeJob());

    expect(mockMarkOutboxFailed).toHaveBeenCalledWith(mockSql, 'outbox-ws-1', 'business_not_found', undefined);
    expect(mockSendInternalEmail).not.toHaveBeenCalled();
  });

  it('skips if subscription not allowed (cancelled)', async () => {
    sqlReturnQueue.push([makeSummaryReportBusiness({ subscription_status: 'cancelled' })]);

    await handleWeeklySummary(makeJob());

    expect(mockSendInternalEmail).not.toHaveBeenCalled();
    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith(mockSql, 'outbox-ws-1', undefined);
  });

  it('skips if subscription not allowed (pending_payment)', async () => {
    sqlReturnQueue.push([makeSummaryReportBusiness({ subscription_status: 'pending_payment' })]);

    await handleWeeklySummary(makeJob());

    expect(mockSendInternalEmail).not.toHaveBeenCalled();
    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith(mockSql, 'outbox-ws-1', undefined);
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
      mockSql,
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

  it('loads the 4-week average from one flat, directly tenant-scoped 28-day reviews query', async () => {
    pushHappyPathSqlQueue();

    await handleWeeklySummary(makeJob());

    const averageQuery = sqlCalls.find(({ text }) => text.includes('COUNT(*)::float / 4.0'));
    expect(averageQuery).toBeDefined();

    const normalizedSql = averageQuery!.text.replace(/\s+/g, ' ').trim();
    expect(normalizedSql.match(/\bSELECT\b/gi)).toHaveLength(1);
    expect(normalizedSql).not.toMatch(/\b(?:JOIN|EXISTS)\b/i);
    expect(normalizedSql).toContain('FROM reviews WHERE business_id = ?');
    expect(normalizedSql).toContain("detected_at >= (?::date - INTERVAL '28 days')");
    expect(normalizedSql).toContain('detected_at < ?::date');
    expect(averageQuery!.values).toEqual(['biz-1', '2026-04-06', '2026-04-06']);
  });

  it('records notification delivery with template=weekly_value_report', async () => {
    pushHappyPathSqlQueue();

    await handleWeeklySummary(makeJob());

    expect(mockRecordNotificationDelivery).toHaveBeenCalledOnce();
    expect(mockRecordNotificationDelivery).toHaveBeenCalledWith(mockSql, {
      accountId: 'acc-1',
      businessId: 'biz-1',
      channel: 'email',
      recipient: 'owner@test.com',
      template: 'weekly_value_report',
      externalMessageId: 'msg-ws-1',
    });
    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith(mockSql, 'outbox-ws-1', undefined);
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
    sqlReturnQueue.push([makeSummaryReportBusiness()]);      // business
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
    expect(mockStartOrGetActiveRun).not.toHaveBeenCalled();
    expect(mockRecordStep).not.toHaveBeenCalled();
    expect(mockRecordOutcome).not.toHaveBeenCalled();
    expect(mockCompleteRun).not.toHaveBeenCalled();
    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith(mockSql, 'outbox-ws-1', undefined);
  });

  it('throws for retry when claimed by another worker (not yet sent)', async () => {
    sqlReturnQueue.push([makeSummaryReportBusiness()]);      // business
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

  it('labels the email as the Insights agent weekly report', async () => {
    pushHappyPathSqlQueue();

    await handleWeeklySummary(makeJob());

    expect(mockSendInternalEmail).toHaveBeenCalledOnce();
    const emailArgs = mockSendInternalEmail.mock.calls[0]![0];
    expect(emailArgs.subject).toBe(
      "Your Insights agent's weekly report — Test Biz (2026-04-06 to 2026-04-13)",
    );
  });

  it('commits the digest_sent run spine in the guarded sent_at transaction before sending', async () => {
    pushHappyPathSqlQueue();

    await handleWeeklySummary(makeJob({ correlation_id: 'corr-weekly-1' }));

    expect(mockSql.begin).toHaveBeenCalledOnce();
    const sentFlip = sqlCalls.find(({ text }) => text.includes('SET sent_at = NOW()'));
    expect(sentFlip).toBeDefined();
    expect(sentFlip!.inTransaction).toBe(true);
    expect(sentFlip!.text).toContain('AND sent_at IS NULL');
    expect(sentFlip!.text).toContain('RETURNING id');

    expect(mockStartOrGetActiveRun).toHaveBeenCalledWith(mockSql, {
      kind: 'weekly_insights',
      subjectType: 'account_week',
      subjectId: 'acc-1_2026-04-06',
      accountId: 'acc-1',
      businessId: 'biz-1',
      correlationId: 'corr-weekly-1',
    });
    expect(mockRecordStep).toHaveBeenCalledWith(mockSql, {
      runId: 'run-weekly-1',
      stepKey: 'digest_sent',
      detail: {
        week_start_date: '2026-04-06',
        business_id: 'biz-1',
      },
    });
    expect(mockRecordOutcome).toHaveBeenCalledWith(mockSql, {
      runId: 'run-weekly-1',
      accountId: 'acc-1',
      businessId: 'biz-1',
      outcomeKind: 'digest_sent',
      attributedAgent: 'insights',
    });
    expect(mockCompleteRun).toHaveBeenCalledWith(mockSql, 'run-weekly-1', 'completed');
    expect(spineTxStates).toEqual([
      { operation: 'start_run', inTransaction: true, tx: mockSql },
      { operation: 'record_step', inTransaction: true, tx: mockSql },
      { operation: 'record_outcome', inTransaction: true, tx: mockSql },
      { operation: 'complete_run', inTransaction: true, tx: mockSql },
    ]);
    expect(transactionEvents).toEqual([
      'sent_at_flip',
      'start_run',
      'record_step',
      'record_outcome',
      'complete_run',
      'send_email',
    ]);
    const transactionSql = sqlCalls.filter(({ inTransaction }) => inTransaction);
    expect(transactionSql).toHaveLength(1);
    expect(transactionSql[0]!.text).not.toMatch(/FROM\s+(?:reviews|businesses)\b/i);
  });

  it('does not send or write the spine when the guarded sent_at flip loses', async () => {
    pushHappyPathSqlQueue({ sentFlipRow: [] });

    await handleWeeklySummary(makeJob());

    expect(transactionEvents).toEqual(['sent_at_flip']);
    expect(mockStartOrGetActiveRun).not.toHaveBeenCalled();
    expect(mockRecordStep).not.toHaveBeenCalled();
    expect(mockRecordOutcome).not.toHaveBeenCalled();
    expect(mockCompleteRun).not.toHaveBeenCalled();
    expect(mockSendInternalEmail).not.toHaveBeenCalled();
    expect(mockRecordNotificationDelivery).not.toHaveBeenCalled();
    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith(mockSql, 'outbox-ws-1', undefined);
  });

  it('fails outbox on email send error', async () => {
    pushHappyPathSqlQueue();
    mockSendInternalEmail.mockRejectedValueOnce(new Error('Resend API error'));

    await handleWeeklySummary(makeJob());

    expect(mockMarkOutboxFailed).toHaveBeenCalledWith(mockSql, 'outbox-ws-1', 'Resend API error', undefined);
    expect(mockRecordNotificationDelivery).not.toHaveBeenCalled();
  });
});
