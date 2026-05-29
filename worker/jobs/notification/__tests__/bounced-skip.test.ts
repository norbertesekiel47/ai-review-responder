import { describe, it, expect, vi, beforeEach } from 'vitest';

// Content-addressed SQL mock.
//
// Previously this file used a single module-level `sqlReturnQueue` drained by
// positional `shift()`. That made every test order-dependent: any divergence
// between the order fixtures were pushed and the order the worker issued its
// sql() calls (a stray/leftover row, or a worker making one more/fewer query)
// silently returned the WRONG fixture for a query — which surfaced under
// parallel load as `Response resp-1 belongs to business undefined, not biz-1`.
//
// Instead, fixtures are keyed by a distinguishing fragment of the query text.
// A query for `responses` can never receive a `businesses` row regardless of
// call order, so a stray or late sql() call cannot desync another test.
const { sqlFixtures, mockSql, mockTx, mockSendApprovalEmail, mockSendInternalEmail, mockMarkOutboxCompleted, mockMarkOutboxFailed } = vi.hoisted(() => {
  // Map of query-text fragment → rows to return when a query contains it.
  const sqlFixtures = new Map<string, unknown[]>();
  const mockTx = vi.fn((_s: TemplateStringsArray, ..._v: unknown[]): Promise<unknown[]> => Promise.resolve([]));
  const mockSql: any = vi.fn((s: TemplateStringsArray, ..._v: unknown[]) => {
    const queryText = (s ?? []).join(' ').replace(/\s+/g, ' ').trim();
    for (const [fragment, rows] of sqlFixtures) {
      if (queryText.includes(fragment)) {
        return Promise.resolve(rows);
      }
    }
    return Promise.resolve([]);
  });
  mockSql.begin = vi.fn(async (cb: (tx: any) => Promise<any>) => cb(mockTx));
  return {
    sqlFixtures, mockSql, mockTx,
    mockSendApprovalEmail: vi.fn().mockResolvedValue({ messageId: 'ok' }),
    mockSendInternalEmail: vi.fn().mockResolvedValue({ messageId: 'ok' }),
    mockMarkOutboxCompleted: vi.fn(),
    mockMarkOutboxFailed: vi.fn(),
  };
});

vi.mock('../../../../src/lib/db/server', () => ({ sql: mockSql, jsonb: (v: unknown) => v }));
vi.mock('../../../../src/lib/notifications/email', async () => {
  const actual = await vi.importActual<typeof import('../../../../src/lib/notifications/email')>(
    '../../../../src/lib/notifications/email',
  );
  return {
    ...actual,
    sendApprovalEmail: (...a: unknown[]) => mockSendApprovalEmail(...a),
    sendInternalEmail: (...a: unknown[]) => mockSendInternalEmail(...a),
  };
});
vi.mock('../../../../src/lib/shared/outbox', () => ({
  markOutboxCompleted: mockMarkOutboxCompleted,
  markOutboxFailed: mockMarkOutboxFailed,
  extractOutboxHandle: (d: any, fallback: string) => ({ outboxId: (d && typeof d.outbox_id === 'string') ? d.outbox_id : fallback, attempt: (d && typeof d.outbox_attempt === 'number') ? d.outbox_attempt : undefined }),
}));
vi.mock('uuid', () => ({ v7: () => 'test-uuid' }));

// Static imports — hoisted above any vi.mock() at runtime by Vitest, so the
// mocks are still applied. Importing at module load (once) removes the cost of
// a cold `await import()` inside each test body, which under heavy parallel
// load could exceed the default 5000ms per-test timeout.
import { handleSendNotification } from '../NotificationWorker';
import { handleWeeklySummary } from '../../WeeklySummaryWorker';
import { handleMonthlyImpact } from '../../MonthlyImpactWorker';
import { handleOnboardingDrip } from '../../OnboardingDripWorker';

// Distinguishing leading fragments of each worker's query (verified against the
// actual SELECTs in context.ts / summary-report-helpers.ts / OnboardingDripWorker.ts).
const Q_NOTIFICATION_RESPONSE = 'SELECT resp.id, resp.response_text';
const Q_NOTIFICATION_BUSINESS = 'SELECT b.name, b.display_label';
const Q_SUMMARY_BUSINESS = 'SELECT b.id, b.name, b.owner_email, b.owner_email_bounced';
const Q_DRIP_BUSINESS = 'SELECT b.id, b.name, b.owner_name, b.owner_email, b.owner_email_bounced';

function resetFixtures() {
  sqlFixtures.clear();
}

function bouncedBusiness(overrides: Record<string, unknown> = {}) {
  return {
    id: 'biz-1',
    name: 'Test Biz',
    owner_name: 'Jane',
    owner_email: 'bounced@example.com',
    owner_email_bounced: true,
    subscription_status: 'active',
    account_updated_at: new Date(),
    ...overrides,
  };
}

function mockResponseRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'resp-1',
    response_text: 'Thank you!',
    status: 'pending_approval',
    resp_business_id: 'biz-1',
    review_id: 'rev-1',
    reviewer_name: 'Jane',
    star_rating: 5,
    review_text: 'Great place!',
    review_date: '2026-04-01',
    ...overrides,
  };
}

describe('NotificationWorker skips bounced owners', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    resetFixtures();
    process.env.NEXT_PUBLIC_APP_URL = 'https://app.test';
    process.env.RESEND_FROM_EMAIL = 'RepWorth <test@test.com>';
    // Drain in-flight microtasks so any promise spawned by a prior test
    // resolves against that test, never inside this one.
    await new Promise((r) => setImmediate(r));
  });

  it('skips approval email when owner_email_bounced is true', async () => {
    sqlFixtures.set(Q_NOTIFICATION_RESPONSE, [mockResponseRow()]);
    sqlFixtures.set(Q_NOTIFICATION_BUSINESS, [bouncedBusiness()]);
    await handleSendNotification({
      id: 'job-1',
      data: { response_id: 'resp-1', business_id: 'biz-1', outbox_id: 'out-1' },
    } as any);
    expect(mockSendApprovalEmail).not.toHaveBeenCalled();
    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith('out-1', undefined);
  });
});

describe('WeeklySummaryWorker skips bounced owners', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    resetFixtures();
    await new Promise((r) => setImmediate(r));
  });

  it('skips weekly report when owner_email_bounced is true', async () => {
    sqlFixtures.set(Q_SUMMARY_BUSINESS, [{ ...bouncedBusiness(), initial_review_count: 0, initial_responded_count: 0, baseline_captured_at: null, subscription_tier: 'standard' }]);
    await handleWeeklySummary({
      id: 'job-2',
      data: { business_id: 'biz-1', week_start_date: '2026-04-13', outbox_id: 'out-2' },
    } as any);
    expect(mockSendInternalEmail).not.toHaveBeenCalled();
    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith('out-2', undefined);
  });
});

describe('MonthlyImpactWorker skips bounced owners', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    resetFixtures();
    await new Promise((r) => setImmediate(r));
  });

  it('skips monthly impact when owner_email_bounced is true', async () => {
    sqlFixtures.set(Q_SUMMARY_BUSINESS, [{ ...bouncedBusiness(), initial_review_count: 0, initial_responded_count: 0, baseline_captured_at: null, subscription_tier: 'standard' }]);
    await handleMonthlyImpact({
      id: 'job-3',
      data: { business_id: 'biz-1', month_start_date: '2026-04-01', outbox_id: 'out-3' },
    } as any);
    expect(mockSendInternalEmail).not.toHaveBeenCalled();
    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith('out-3', undefined);
  });
});

describe('OnboardingDripWorker skips bounced owners', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    resetFixtures();
    await new Promise((r) => setImmediate(r));
  });

  it('skips drip when owner_email_bounced is true', async () => {
    sqlFixtures.set(Q_DRIP_BUSINESS, [{ ...bouncedBusiness(), subscription_activated_at: new Date(), initial_review_count: 0, initial_responded_count: 0 }]);
    await handleOnboardingDrip({
      id: 'job-4',
      data: { business_id: 'biz-1', drip_type: 'day_1', outbox_id: 'out-4' },
    } as any);
    expect(mockSendInternalEmail).not.toHaveBeenCalled();
    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith('out-4', undefined);
  });
});
