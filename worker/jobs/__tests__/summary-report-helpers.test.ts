import { describe, expect, it, vi, beforeEach } from 'vitest';

const { mockMarkOutboxCompleted, mockMarkOutboxFailed } = vi.hoisted(() => ({
  mockMarkOutboxCompleted: vi.fn(() => Promise.resolve()),
  mockMarkOutboxFailed: vi.fn(() => Promise.resolve()),
}));

vi.mock('../../../src/lib/shared/outbox', () => ({
  markOutboxCompleted: mockMarkOutboxCompleted,
  markOutboxFailed: mockMarkOutboxFailed,
}));

import {
  buildDashboardUrl,
  calculateBaselineResponseRate,
  completeOrFailSkippedSummaryReport,
  mapSummaryReviews,
  type SummaryReportBusiness,
} from '../summary-report-helpers';

function makeBusiness(overrides: Partial<SummaryReportBusiness> = {}): SummaryReportBusiness {
  return {
    id: 'biz-1',
    account_id: 'acc-1',
    name: 'Test Co',
    owner_email: 'owner@example.com',
    owner_email_bounced: false,
    subscription_status: 'active',
    account_updated_at: new Date('2026-01-01'),
    account_past_due_at: null,
    account_flags: {},
    initial_review_count: null,
    initial_responded_count: null,
    baseline_captured_at: null,
    subscription_tier: 'pro',
    archived_at: null,
    ...overrides,
  };
}

describe('summary report helpers', () => {
  it('calculates a rounded baseline response rate when baseline data is complete', () => {
    expect(
      calculateBaselineResponseRate({
        baseline_captured_at: new Date('2026-01-01'),
        initial_review_count: 37,
        initial_responded_count: 18,
      }),
    ).toBe(49);
  });

  it('returns null when baseline data is incomplete', () => {
    expect(
      calculateBaselineResponseRate({
        baseline_captured_at: null,
        initial_review_count: 37,
        initial_responded_count: 18,
      }),
    ).toBeNull();
    expect(
      calculateBaselineResponseRate({
        baseline_captured_at: new Date('2026-01-01'),
        initial_review_count: 0,
        initial_responded_count: 18,
      }),
    ).toBeNull();
  });

  it('only builds dashboard URLs when the owner has auth and app URL is configured', () => {
    expect(buildDashboardUrl([{ exists: 1 }], 'https://app.repworth.com')).toBe(
      'https://app.repworth.com/dashboard',
    );
    expect(buildDashboardUrl([], 'https://app.repworth.com')).toBeNull();
    expect(buildDashboardUrl([{ exists: 1 }], undefined)).toBeNull();
  });

  it('maps review rows into the LLM summary shape', () => {
    expect(
      mapSummaryReviews([
        { star_rating: 5, review_text: 'Great' },
        { star_rating: 2, review_text: null },
      ]),
    ).toEqual([
      { starRating: 5, reviewText: 'Great' },
      { starRating: 2, reviewText: null },
    ]);
  });
});

describe('completeOrFailSkippedSummaryReport — archived locations', () => {
  const fakeLogger = { warn: vi.fn(), log: vi.fn() };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('skips an archived business as success (completes outbox, never fails)', async () => {
    const skipped = await completeOrFailSkippedSummaryReport({
      business: makeBusiness({ archived_at: '2026-06-01T00:00:00Z' as unknown as Date }),
      businessId: 'biz-1' as never,
      outboxId: 'o1',
      outboxAttempt: 1,
      logger: fakeLogger,
    });

    expect(skipped).toBe(true);
    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith('o1', 1);
    expect(mockMarkOutboxFailed).not.toHaveBeenCalled();
  });

  it('checks archived before subscription — a cancelled archived business still completes (not fails)', async () => {
    const skipped = await completeOrFailSkippedSummaryReport({
      business: makeBusiness({
        archived_at: '2026-06-01T00:00:00Z' as unknown as Date,
        subscription_status: 'cancelled',
      }),
      businessId: 'biz-1' as never,
      outboxId: 'o2',
      outboxAttempt: undefined,
      logger: fakeLogger,
    });

    expect(skipped).toBe(true);
    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith('o2', undefined);
    expect(mockMarkOutboxFailed).not.toHaveBeenCalled();
    // Pins ordering: the archived branch emits this exact message. If the
    // subscription check ran first, a cancelled business would log the
    // subscription-skip reason instead, and this assertion would fail.
    expect(fakeLogger.log).toHaveBeenCalledWith(
      'Business biz-1 archived — skipping summary report',
    );
  });

  it('proceeds (returns false) for a non-archived active business — regression', async () => {
    const skipped = await completeOrFailSkippedSummaryReport({
      business: makeBusiness({ archived_at: null }),
      businessId: 'biz-1' as never,
      outboxId: 'o3',
      outboxAttempt: 1,
      logger: fakeLogger,
    });

    expect(skipped).toBe(false);
    expect(mockMarkOutboxCompleted).not.toHaveBeenCalled();
    expect(mockMarkOutboxFailed).not.toHaveBeenCalled();
  });
});
