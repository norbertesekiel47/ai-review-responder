import { describe, expect, it, vi, beforeEach } from 'vitest';
import type postgres from 'postgres';

const { mockMarkOutboxCompleted, mockMarkOutboxFailed } = vi.hoisted(() => ({
  mockMarkOutboxCompleted: vi.fn(() => Promise.resolve()),
  mockMarkOutboxFailed: vi.fn(() => Promise.resolve()),
}));

vi.mock('../../../src/lib/shared/outbox', () => ({
  markOutboxCompleted: mockMarkOutboxCompleted,
  markOutboxFailed: mockMarkOutboxFailed,
}));

import {
  calculateBaselineResponseRate,
  completeOrFailSkippedSummaryReport,
  mapSummaryReviews,
} from '../summary-report-helpers';
import { asLocationId } from '../../../src/lib/shared/ids';
import { SKIP_REASON_ARCHIVED_LOCATION } from '../../../src/lib/shared/worker-types';
import { makeSummaryReportBusiness } from './summary-report-fixtures';

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

  // The `buildDashboardUrl` case that lived here was deleted with the function
  // in #719 Task 2. Its three assertions are superseded, not dropped: live-schema
  // titles 2, 3 and 7 in worker/jobs/__tests__/onboarding-drip.integration.test.ts
  // assert owner-with-auth → URL, owner-without-auth → null, and no-app-URL → null
  // against real Postgres. That matters — this suite fed the old helper a
  // hand-built Array<{exists:number}>, which is precisely why it could not catch
  // the dropped users.business_id column that made every call throw 42703.

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
  // The skip branches only FORWARD `sql` to the (mocked) outbox writers; they
  // never run a query on it, so a sentinel is enough and each assertion pins
  // that the same client is threaded through as the leading arg.
  const fakeSql = {} as unknown as postgres.Sql;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('skips an archived business as success (completes outbox, never fails)', async () => {
    const skipped = await completeOrFailSkippedSummaryReport(fakeSql, {
      business: makeSummaryReportBusiness({ archived_at: new Date('2026-06-01T00:00:00Z') }),
      businessId: asLocationId('biz-1'),
      outboxId: 'o1',
      outboxAttempt: 1,
      logger: fakeLogger,
    });

    expect(skipped).toBe(true);
    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith(fakeSql, 'o1', 1);
    expect(mockMarkOutboxFailed).not.toHaveBeenCalled();
  });

  it('checks archived before subscription — pinned via the structured skip log', async () => {
    const skipped = await completeOrFailSkippedSummaryReport(fakeSql, {
      business: makeSummaryReportBusiness({
        archived_at: new Date('2026-06-01T00:00:00Z'),
        subscription_status: 'cancelled',
      }),
      businessId: asLocationId('biz-1'),
      outboxId: 'o2',
      outboxAttempt: undefined,
      logger: fakeLogger,
    });

    expect(skipped).toBe(true);
    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith(fakeSql, 'o2', undefined);
    expect(mockMarkOutboxFailed).not.toHaveBeenCalled();
    // Pins ordering: only the archived branch logs the structured
    // { reason: archived_location } object arg. If the subscription check
    // ran first, the cancelled business would take the subscription-skip
    // branch (plain string log, no reason object) and this would fail.
    expect(fakeLogger.log).toHaveBeenCalledWith(
      'archived — skipping summary report',
      expect.objectContaining({ reason: SKIP_REASON_ARCHIVED_LOCATION, business_id: 'biz-1' }),
    );
  });

  it('proceeds (returns false) for a non-archived active business — regression', async () => {
    const skipped = await completeOrFailSkippedSummaryReport(fakeSql, {
      business: makeSummaryReportBusiness({ archived_at: null }),
      businessId: asLocationId('biz-1'),
      outboxId: 'o3',
      outboxAttempt: 1,
      logger: fakeLogger,
    });

    expect(skipped).toBe(false);
    expect(mockMarkOutboxCompleted).not.toHaveBeenCalled();
    expect(mockMarkOutboxFailed).not.toHaveBeenCalled();
  });
});
