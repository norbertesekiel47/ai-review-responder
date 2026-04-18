import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Job } from 'bullmq';
import type { SendNotificationPayload } from '../../src/lib/shared/worker-types';

// ── Hoisted state shared between mock factories and tests ──────────────
const {
  sqlReturnQueue,
  mockSql,
  mockTx,
  mockMarkOutboxCompleted,
  mockMarkOutboxFailed,
  mockSendApprovalEmail,
} = vi.hoisted(() => {
  const sqlReturnQueue: unknown[] = [];

  const mockTx = vi.fn(
    (_s: TemplateStringsArray, ..._v: unknown[]): Promise<unknown[]> => {
      return Promise.resolve([]);
    },
  );

  const mockSql: any = vi.fn((_s: TemplateStringsArray, ..._v: unknown[]) => {
    const result = sqlReturnQueue.shift() ?? [];
    return Promise.resolve(result);
  });

  mockSql.begin = vi.fn(async (cb: (tx: any) => Promise<any>) => cb(mockTx));

  return {
    sqlReturnQueue,
    mockSql,
    mockTx,
    mockMarkOutboxCompleted: vi.fn(),
    mockMarkOutboxFailed: vi.fn(),
    mockSendApprovalEmail: vi.fn().mockResolvedValue({ messageId: 'msg-123' }),
  };
});

// ── Module mocks (hoisted by vitest) ───────────────────────────────────
vi.mock('../../src/lib/db/server', () => ({
  sql: mockSql, jsonb: (v: unknown) => v }));

vi.mock('../../src/lib/shared/outbox', () => ({
  markOutboxCompleted: mockMarkOutboxCompleted,
  markOutboxFailed: mockMarkOutboxFailed,
}));

vi.mock('../../src/lib/notifications/email', () => ({
  sendApprovalEmail: mockSendApprovalEmail,
}));

vi.mock('uuid', () => ({
  v7: vi.fn(() => 'test-uuid'),
}));

// Do NOT mock subscription-guard — use the real implementation

// Import after mocks are wired
import { handleSendNotification } from '../jobs/NotificationWorker';

// ── Helpers ────────────────────────────────────────────────────────────

function makeJob(): Job<SendNotificationPayload> {
  return {
    data: { response_id: 'resp-1', business_id: 'biz-1' },
    id: 'outbox-notif-1',
  } as Job<SendNotificationPayload>;
}

function mockResponseRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'resp-1',
    response_text: 'Thank you, Jane!',
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

function mockBusinessRow(overrides: Record<string, unknown> = {}) {
  return {
    owner_email: 'owner@test.com',
    owner_name: 'Owner',
    name: 'Test Biz',
    subscription_status: 'active',
    updated_at: new Date(),
    ...overrides,
  };
}

// ── Tests ──────────────────────────────────────────────────────────────

describe('NotificationWorker – handleSendNotification', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sqlReturnQueue.length = 0;
    mockTx.mockImplementation(() => Promise.resolve([]));
    process.env.NEXT_PUBLIC_APP_URL = 'https://app.test';
    process.env.RESEND_FROM_EMAIL = 'RepWorth <test@test.com>';
  });

  // 1. Success flow
  it('creates approval link, sends email, records delivery, and completes outbox', async () => {
    sqlReturnQueue.push([mockResponseRow()]);           // 1: response+review SELECT
    sqlReturnQueue.push([mockBusinessRow()]);            // 2: business SELECT
    sqlReturnQueue.push([]);                             // 3: existing delivery check → none
    // sql.begin: revoke orphans (0 affected) + insert link → 2 tx calls
    // sendApprovalEmail handled by mockSendApprovalEmail
    sqlReturnQueue.push([]);                             // INSERT notification_deliveries

    await handleSendNotification(makeJob());

    // Transaction: revoke orphans + create link
    expect(mockSql.begin).toHaveBeenCalledOnce();
    expect(mockTx).toHaveBeenCalledTimes(2);

    // Email sent with correct params
    expect(mockSendApprovalEmail).toHaveBeenCalledOnce();
    const emailArgs = mockSendApprovalEmail.mock.calls[0]![0] as Record<string, unknown>;
    expect(emailArgs.to).toBe('owner@test.com');
    expect(emailArgs.businessName).toBe('Test Biz');
    expect(emailArgs.reviewerName).toBe('Jane');
    expect(emailArgs.starRating).toBe(5);
    expect(emailArgs.approvalUrl).toMatch(/^https:\/\/app\.test\/approve\//);

    // Outbox completed
    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith('outbox-notif-1');
    expect(mockMarkOutboxFailed).not.toHaveBeenCalled();
  });

  // 2. Subscription pending_payment blocks notification worker
  it('skips notification for pending_payment subscription', async () => {
    sqlReturnQueue.push([mockResponseRow()]);
    sqlReturnQueue.push([mockBusinessRow({ subscription_status: 'pending_payment' })]);

    await handleSendNotification(makeJob());

    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith('outbox-notif-1');
    expect(mockSendApprovalEmail).not.toHaveBeenCalled();
    expect(mockSql.begin).not.toHaveBeenCalled();
  });

  // 3. Existing delivery (idempotent skip)
  it('completes outbox without sending when delivery already exists', async () => {
    sqlReturnQueue.push([mockResponseRow()]);
    sqlReturnQueue.push([mockBusinessRow()]);
    sqlReturnQueue.push([{ id: 'existing-delivery-1' }]); // existing delivery found

    await handleSendNotification(makeJob());

    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith('outbox-notif-1');
    expect(mockSendApprovalEmail).not.toHaveBeenCalled();
    expect(mockSql.begin).not.toHaveBeenCalled();
  });

  // 4. Orphaned link revocation (now atomic — revoke + create in same transaction)
  it('revokes orphaned links and creates new one in same transaction', async () => {
    sqlReturnQueue.push([mockResponseRow()]);           // 1: response+review
    sqlReturnQueue.push([mockBusinessRow()]);            // 2: business
    sqlReturnQueue.push([]);                             // 3: no existing delivery
    // sql.begin: tx call 1 = UPDATE revoke orphans, tx call 2 = INSERT new link
    // sendApprovalEmail handled by mock
    sqlReturnQueue.push([]);                             // INSERT notification_deliveries

    await handleSendNotification(makeJob());

    // Both revoke + insert happened in the same transaction
    expect(mockSql.begin).toHaveBeenCalledOnce();
    expect(mockTx).toHaveBeenCalledTimes(2);

    // Verify the revoke was inside the transaction (tx call, not sql call)
    const txCallStrings = mockTx.mock.calls.map(
      (call: unknown[]) => Array.from(call[0] as TemplateStringsArray).join(''),
    );
    const hasRevoke = txCallStrings.some((s: string) => s.includes('revoked_at'));
    expect(hasRevoke).toBe(true);

    expect(mockSendApprovalEmail).toHaveBeenCalledOnce();
    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith('outbox-notif-1');
  });

  // 5. Email send failure — throws for BullMQ retry
  it('throws when sendApprovalEmail fails, outbox not completed', async () => {
    sqlReturnQueue.push([mockResponseRow()]);
    sqlReturnQueue.push([mockBusinessRow()]);
    sqlReturnQueue.push([]);                             // no existing delivery
    // sql.begin: revoke orphans + insert link (handled by mockTx)

    mockSendApprovalEmail.mockRejectedValueOnce(new Error('Resend API timeout'));

    await expect(handleSendNotification(makeJob())).rejects.toThrow('Resend API timeout');

    expect(mockMarkOutboxCompleted).not.toHaveBeenCalled();
    expect(mockMarkOutboxFailed).not.toHaveBeenCalled();
  });

  // ── Failover mode tests ───────────────────────────────────────────

  // 6. Failover skips when delivery already succeeded
  it('failover: completes without sending when delivered_at exists', async () => {
    const job = makeJob();
    (job.data as any).failover = { reason: 'stale_no_delivery' as const };

    sqlReturnQueue.push([mockResponseRow()]);           // 1: response+review
    sqlReturnQueue.push([mockBusinessRow()]);            // 2: business
    sqlReturnQueue.push([{ id: 'delivered-1' }]);        // 3: failover delivered check → found

    await handleSendNotification(job);

    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith('outbox-notif-1');
    expect(mockSendApprovalEmail).not.toHaveBeenCalled();
    expect(mockSql.begin).not.toHaveBeenCalled();
  });

  // 7. Failover re-sends even when old sent_at delivery exists (the key distinction)
  it('failover: re-sends when sent_at exists but no delivered_at', async () => {
    const job = makeJob();
    (job.data as any).failover = { reason: 'stale_no_delivery' as const };

    sqlReturnQueue.push([mockResponseRow()]);           // 1: response+review
    sqlReturnQueue.push([mockBusinessRow()]);            // 2: business
    sqlReturnQueue.push([]);                             // 3: failover delivered check → none found
    // sql.begin: revoke orphans + create link → 2 tx calls
    sqlReturnQueue.push([]);                             // INSERT notification_deliveries

    await handleSendNotification(job);

    expect(mockSql.begin).toHaveBeenCalledOnce();
    expect(mockSendApprovalEmail).toHaveBeenCalledOnce();
    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith('outbox-notif-1');
  });

  // 8. Failover respects subscription guard
  it('failover: skips for cancelled subscription', async () => {
    const job = makeJob();
    (job.data as any).failover = { reason: 'all_deliveries_failed' as const };

    sqlReturnQueue.push([mockResponseRow()]);
    sqlReturnQueue.push([mockBusinessRow({ subscription_status: 'cancelled' })]);

    await handleSendNotification(job);

    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith('outbox-notif-1');
    expect(mockSendApprovalEmail).not.toHaveBeenCalled();
  });
});
