import { describe, it, expect, vi, beforeEach } from 'vitest';

const { sqlReturnQueue, mockSql, mockTx, mockSendApprovalEmail, mockSendInternalEmail, mockMarkOutboxCompleted, mockMarkOutboxFailed } = vi.hoisted(() => {
  const sqlReturnQueue: unknown[] = [];
  const mockTx = vi.fn((_s: TemplateStringsArray, ..._v: unknown[]): Promise<unknown[]> => Promise.resolve([]));
  const mockSql: any = vi.fn((_s: TemplateStringsArray, ..._v: unknown[]) => {
    const result = sqlReturnQueue.shift() ?? [];
    return Promise.resolve(Array.isArray(result) ? result : [result]);
  });
  mockSql.begin = vi.fn(async (cb: (tx: any) => Promise<any>) => cb(mockTx));
  return {
    sqlReturnQueue, mockSql, mockTx,
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
  beforeEach(() => {
    vi.clearAllMocks();
    sqlReturnQueue.length = 0;
    process.env.NEXT_PUBLIC_APP_URL = 'https://app.test';
    process.env.RESEND_FROM_EMAIL = 'RepWorth <test@test.com>';
  });

  it('skips approval email when owner_email_bounced is true', async () => {
    sqlReturnQueue.push([mockResponseRow()]);
    sqlReturnQueue.push([bouncedBusiness()]);
    const { handleSendNotification } = await import('../NotificationWorker');
    await handleSendNotification({
      id: 'job-1',
      data: { response_id: 'resp-1', business_id: 'biz-1', outbox_id: 'out-1' },
    } as any);
    expect(mockSendApprovalEmail).not.toHaveBeenCalled();
    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith('out-1', undefined);
  });
});

describe('WeeklySummaryWorker skips bounced owners', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sqlReturnQueue.length = 0;
  });

  it('skips weekly report when owner_email_bounced is true', async () => {
    sqlReturnQueue.push([{ ...bouncedBusiness(), initial_review_count: 0, initial_responded_count: 0, baseline_captured_at: null, subscription_tier: 'standard' }]);
    const { handleWeeklySummary } = await import('../../WeeklySummaryWorker');
    await handleWeeklySummary({
      id: 'job-2',
      data: { business_id: 'biz-1', week_start_date: '2026-04-13', outbox_id: 'out-2' },
    } as any);
    expect(mockSendInternalEmail).not.toHaveBeenCalled();
    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith('out-2', undefined);
  });
});

describe('MonthlyImpactWorker skips bounced owners', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sqlReturnQueue.length = 0;
  });

  it('skips monthly impact when owner_email_bounced is true', async () => {
    sqlReturnQueue.push([{ ...bouncedBusiness(), initial_review_count: 0, initial_responded_count: 0, baseline_captured_at: null, subscription_tier: 'standard' }]);
    const { handleMonthlyImpact } = await import('../../MonthlyImpactWorker');
    await handleMonthlyImpact({
      id: 'job-3',
      data: { business_id: 'biz-1', month_start_date: '2026-04-01', outbox_id: 'out-3' },
    } as any);
    expect(mockSendInternalEmail).not.toHaveBeenCalled();
    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith('out-3', undefined);
  });
});

describe('OnboardingDripWorker skips bounced owners', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sqlReturnQueue.length = 0;
  });

  it('skips drip when owner_email_bounced is true', async () => {
    sqlReturnQueue.push([{ ...bouncedBusiness(), subscription_activated_at: new Date(), initial_review_count: 0, initial_responded_count: 0 }]);
    const { handleOnboardingDrip } = await import('../../OnboardingDripWorker');
    await handleOnboardingDrip({
      id: 'job-4',
      data: { business_id: 'biz-1', drip_type: 'day_1', outbox_id: 'out-4' },
    } as any);
    expect(mockSendInternalEmail).not.toHaveBeenCalled();
    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith('out-4', undefined);
  });
});
