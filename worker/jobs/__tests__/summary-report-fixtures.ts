import type { SummaryReportBusiness } from '../summary-report-helpers';

/**
 * Single factory for the SummaryReportBusiness projection used by the
 * summary-report helper, WeeklySummaryWorker, and MonthlyImpactWorker tests.
 * Defaults represent a healthy, active, non-archived business with a captured
 * baseline (10/50 responded → 20% baseline response rate).
 */
export function makeSummaryReportBusiness(
  overrides: Partial<SummaryReportBusiness> = {},
): SummaryReportBusiness {
  return {
    id: 'biz-1',
    account_id: 'acc-1',
    name: 'Test Biz',
    owner_email: 'owner@test.com',
    owner_email_bounced: false,
    subscription_status: 'active',
    account_updated_at: new Date('2026-01-01'),
    account_past_due_at: null,
    account_flags: {},
    initial_review_count: 50,
    initial_responded_count: 10,
    baseline_captured_at: new Date('2026-01-01'),
    subscription_tier: 'standard',
    archived_at: null,
    ...overrides,
  };
}
