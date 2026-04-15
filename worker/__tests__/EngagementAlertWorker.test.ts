import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Job } from 'bullmq';
import type { EngagementAlertPayload } from '../../src/lib/shared/worker-types';

// ── Hoisted mock state ───────────────────────────────────────────────
const {
  sqlReturnQueue,
  mockSql,
  mockMarkOutboxCompleted,
  mockMarkOutboxFailed,
  mockSendInternalEmail,
  mockBuildOwnerNudgeEmailHtml,
  mockBuildPartnerEngagementAlertHtml,
  mockBuildPartnerEscalationAlertHtml,
  mockBuildPartnerLowEngagementAlertHtml,
  mockRecordNotificationDelivery,
  mockCreateApprovalLink,
} = vi.hoisted(() => {
  const sqlReturnQueue: unknown[] = [];

  const mockSql: any = vi.fn((_s: TemplateStringsArray, ..._v: unknown[]) => {
    const result = sqlReturnQueue.shift() ?? [];
    return Promise.resolve(result);
  });

  mockSql.begin = vi.fn(async (cb: (tx: any) => Promise<any>) => cb(mockSql));

  let linkCounter = 0;

  return {
    sqlReturnQueue,
    mockSql,
    mockMarkOutboxCompleted: vi.fn(),
    mockMarkOutboxFailed: vi.fn(),
    mockSendInternalEmail: vi.fn().mockResolvedValue({ messageId: 'msg-ea-1' }),
    mockBuildOwnerNudgeEmailHtml: vi.fn(() => '<html>nudge</html>'),
    mockBuildPartnerEngagementAlertHtml: vi.fn(() => '<html>engagement</html>'),
    mockBuildPartnerEscalationAlertHtml: vi.fn(() => '<html>escalation</html>'),
    mockBuildPartnerLowEngagementAlertHtml: vi.fn(() => '<html>low-engagement</html>'),
    mockRecordNotificationDelivery: vi.fn(),
    mockCreateApprovalLink: vi.fn().mockImplementation(() => {
      linkCounter++;
      return Promise.resolve({ rawToken: `token-${linkCounter}`, tokenHash: `hash-${linkCounter}` });
    }),
  };
});

vi.mock('../../src/lib/db/server', () => ({ sql: mockSql }));
vi.mock('../../src/lib/shared/outbox', () => ({
  markOutboxCompleted: mockMarkOutboxCompleted,
  markOutboxFailed: mockMarkOutboxFailed,
}));
vi.mock('../../src/lib/notifications/email', () => ({
  sendInternalEmail: mockSendInternalEmail,
  buildOwnerNudgeEmailHtml: mockBuildOwnerNudgeEmailHtml,
  buildPartnerEngagementAlertHtml: mockBuildPartnerEngagementAlertHtml,
  buildPartnerEscalationAlertHtml: mockBuildPartnerEscalationAlertHtml,
  buildPartnerLowEngagementAlertHtml: mockBuildPartnerLowEngagementAlertHtml,
}));
vi.mock('../../src/lib/notifications/delivery', () => ({
  recordNotificationDelivery: mockRecordNotificationDelivery,
}));
vi.mock('../../src/lib/approval/create-link', () => ({
  createApprovalLink: mockCreateApprovalLink,
}));

import { handleEngagementAlert } from '../jobs/EngagementAlertWorker';

// ── Helpers ─────────────────────────────────────────────────────────

function makeJob(overrides: Partial<EngagementAlertPayload> = {}): Job<EngagementAlertPayload> {
  return {
    data: {
      business_id: 'biz-1',
      alert_type: 'owner_nudge',
      metrics: {
        days_since_approval: 5,
        oldest_pending_age_days: 5,
        pending_count: 3,
        approval_rate: 60,
        notified_count: 3,
      },
      ...overrides,
    },
    id: 'outbox-ea-1',
  } as Job<EngagementAlertPayload>;
}

function mockBusinessRow(overrides: Record<string, unknown> = {}) {
  return {
    name: 'Test Biz',
    owner_email: 'owner@test.com',
    owner_phone: '+1234567890',
    subscription_status: 'active',
    updated_at: new Date(),
    ...overrides,
  };
}

function pushPendingReviewRows(count: number = 2, totalPending?: number) {
  const total = totalPending ?? count;
  const rows = Array.from({ length: count }, (_, i) => ({
    response_id: `resp-${i + 1}`,
    reviewer_name: `Reviewer ${i + 1}`,
    star_rating: 4 + (i % 2),
    review_text: i % 2 === 0 ? `Great review ${i + 1}` : null,
    total_pending: total,
  }));
  sqlReturnQueue.push(rows);
}

// ── Tests ───────────────────────────────────────────────────────────

describe('EngagementAlertWorker – handleEngagementAlert', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sqlReturnQueue.length = 0;
    process.env.NEXT_PUBLIC_APP_URL = 'https://app.repworth.com';
    process.env.ADMIN_NOTIFICATION_EMAIL = 'admin@repworth.com';
    process.env.RESEND_FROM_EMAIL = 'RepWorth <noreply@repworth.com>';
  });

  // ── Common guards ──────────────────────────────────────────────────

  it('fails outbox if business not found', async () => {
    sqlReturnQueue.push([]); // business query returns empty

    await handleEngagementAlert(makeJob());

    expect(mockMarkOutboxFailed).toHaveBeenCalledWith('outbox-ea-1', 'business_not_found');
    expect(mockSendInternalEmail).not.toHaveBeenCalled();
  });

  it('skips if subscription not allowed (cancelled)', async () => {
    sqlReturnQueue.push([mockBusinessRow({ subscription_status: 'cancelled' })]);

    await handleEngagementAlert(makeJob());

    expect(mockSendInternalEmail).not.toHaveBeenCalled();
    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith('outbox-ea-1');
  });

  it('skips if subscription not allowed (pending_payment)', async () => {
    sqlReturnQueue.push([mockBusinessRow({ subscription_status: 'pending_payment' })]);

    await handleEngagementAlert(makeJob());

    expect(mockSendInternalEmail).not.toHaveBeenCalled();
    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith('outbox-ea-1');
  });

  // ── Owner nudge ───────────────────────────────────────────────────

  it('owner_nudge: sends nudge email with pending reviews and approval links', async () => {
    sqlReturnQueue.push([mockBusinessRow()]); // business
    pushPendingReviewRows(2);                 // 2 pending reviews

    await handleEngagementAlert(makeJob({ alert_type: 'owner_nudge' }));

    // Created approval links for each pending review with revokeMode: 'always'
    expect(mockCreateApprovalLink).toHaveBeenCalledTimes(2);
    expect(mockCreateApprovalLink).toHaveBeenCalledWith({ responseId: 'resp-1', businessId: 'biz-1', revokeMode: 'always' });
    expect(mockCreateApprovalLink).toHaveBeenCalledWith({ responseId: 'resp-2', businessId: 'biz-1', revokeMode: 'always' });

    // Built nudge email with correct params
    expect(mockBuildOwnerNudgeEmailHtml).toHaveBeenCalledOnce();
    const nudgeParams = (mockBuildOwnerNudgeEmailHtml.mock.calls as unknown[][])[0]![0] as Record<string, unknown>;
    expect(nudgeParams.businessName).toBe('Test Biz');
    const pendingReviews = nudgeParams.pendingReviews as Array<{ reviewerName: string; approvalUrl: string }>;
    expect(pendingReviews).toHaveLength(2);
    expect(pendingReviews[0]!.reviewerName).toBe('Reviewer 1');
    expect(pendingReviews[0]!.approvalUrl).toMatch(/^https:\/\/app\.repworth\.com\/approve\/token-/);
    expect(pendingReviews[1]!.reviewerName).toBe('Reviewer 2');

    // Sent email to owner
    expect(mockSendInternalEmail).toHaveBeenCalledWith({
      to: 'owner@test.com',
      subject: 'You have 2 reviews waiting for your approval',
      bodyHtml: '<html>nudge</html>',
    });

    // Recorded delivery
    expect(mockRecordNotificationDelivery).toHaveBeenCalledWith({
      businessId: 'biz-1',
      channel: 'email',
      recipient: 'owner@test.com',
      template: 'owner_nudge',
      externalMessageId: 'msg-ea-1',
    });

    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith('outbox-ea-1');
  });

  it('owner_nudge: skips gracefully when no pending reviews', async () => {
    sqlReturnQueue.push([mockBusinessRow()]); // business
    sqlReturnQueue.push([]);                  // no pending reviews

    await handleEngagementAlert(makeJob({ alert_type: 'owner_nudge' }));

    expect(mockCreateApprovalLink).not.toHaveBeenCalled();
    expect(mockSendInternalEmail).not.toHaveBeenCalled();
    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith('outbox-ea-1');
  });

  it('owner_nudge: fails outbox if NEXT_PUBLIC_APP_URL not set', async () => {
    delete process.env.NEXT_PUBLIC_APP_URL;
    sqlReturnQueue.push([mockBusinessRow()]); // business

    await handleEngagementAlert(makeJob({ alert_type: 'owner_nudge' }));

    expect(mockMarkOutboxFailed).toHaveBeenCalledWith('outbox-ea-1', 'NEXT_PUBLIC_APP_URL not configured');
    expect(mockCreateApprovalLink).not.toHaveBeenCalled();
    expect(mockSendInternalEmail).not.toHaveBeenCalled();
  });

  it('owner_nudge: fails outbox if RESEND_FROM_EMAIL not set', async () => {
    delete process.env.RESEND_FROM_EMAIL;
    sqlReturnQueue.push([mockBusinessRow()]); // business

    await handleEngagementAlert(makeJob({ alert_type: 'owner_nudge' }));

    expect(mockMarkOutboxFailed).toHaveBeenCalledWith('outbox-ea-1', 'RESEND_FROM_EMAIL not configured');
    expect(mockCreateApprovalLink).not.toHaveBeenCalled();
    expect(mockSendInternalEmail).not.toHaveBeenCalled();
  });

  it('owner_nudge: uses singular "review" for count of 1', async () => {
    sqlReturnQueue.push([mockBusinessRow()]); // business
    pushPendingReviewRows(1);                 // 1 pending review

    await handleEngagementAlert(makeJob({ alert_type: 'owner_nudge' }));

    const emailArgs = mockSendInternalEmail.mock.calls[0]![0];
    expect(emailArgs.subject).toBe('You have 1 review waiting for your approval');
  });

  // ── Partner engagement alert ──────────────────────────────────────

  it('partner_engagement_alert: sends alert to admin with correct subject', async () => {
    sqlReturnQueue.push([mockBusinessRow()]); // business

    await handleEngagementAlert(makeJob({
      alert_type: 'partner_engagement_alert',
      metrics: {
        days_since_approval: 10,
        oldest_pending_age_days: 12,
        pending_count: 4,
        approval_rate: 45,
        notified_count: 4,
      },
    }));

    expect(mockBuildPartnerEngagementAlertHtml).toHaveBeenCalledOnce();
    const params = (mockBuildPartnerEngagementAlertHtml.mock.calls as unknown[][])[0]![0] as Record<string, unknown>;
    expect(params.businessName).toBe('Test Biz');
    expect(params.daysSinceApproval).toBe(10);
    expect(params.pendingCount).toBe(4);
    expect(params.approvalRate).toBe(45);
    expect(params.ownerEmail).toBe('owner@test.com');
    expect(params.ownerPhone).toBe('+1234567890');

    expect(mockSendInternalEmail).toHaveBeenCalledWith({
      to: 'admin@repworth.com',
      subject: "Customer Test Biz hasn't engaged in 10 days",
      bodyHtml: '<html>engagement</html>',
    });

    expect(mockRecordNotificationDelivery).toHaveBeenCalledWith({
      businessId: 'biz-1',
      channel: 'email',
      recipient: 'admin@repworth.com',
      template: 'partner_engagement_alert',
      externalMessageId: 'msg-ea-1',
    });

    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith('outbox-ea-1');
  });

  it('partner_engagement_alert: falls back to oldest_pending_age_days in subject', async () => {
    sqlReturnQueue.push([mockBusinessRow()]);

    await handleEngagementAlert(makeJob({
      alert_type: 'partner_engagement_alert',
      metrics: {
        days_since_approval: null,
        oldest_pending_age_days: 8,
        pending_count: 2,
        approval_rate: null,
        notified_count: 2,
      },
    }));

    const emailArgs = mockSendInternalEmail.mock.calls[0]![0];
    expect(emailArgs.subject).toBe("Customer Test Biz hasn't engaged in 8 days");
  });

  // ── Partner escalation alert ──────────────────────────────────────

  it('partner_escalation_alert: sends escalation email to admin', async () => {
    sqlReturnQueue.push([mockBusinessRow()]);

    await handleEngagementAlert(makeJob({
      alert_type: 'partner_escalation_alert',
      metrics: {
        days_since_approval: 18,
        oldest_pending_age_days: 20,
        pending_count: 6,
        approval_rate: 30,
        notified_count: 6,
      },
    }));

    expect(mockBuildPartnerEscalationAlertHtml).toHaveBeenCalledOnce();
    const params = (mockBuildPartnerEscalationAlertHtml.mock.calls as unknown[][])[0]![0] as Record<string, unknown>;
    expect(params.businessName).toBe('Test Biz');
    expect(params.daysSinceApproval).toBe(18);

    expect(mockSendInternalEmail).toHaveBeenCalledWith({
      to: 'admin@repworth.com',
      subject: 'Customer Test Biz may be at risk',
      bodyHtml: '<html>escalation</html>',
    });

    expect(mockRecordNotificationDelivery).toHaveBeenCalledWith({
      businessId: 'biz-1',
      channel: 'email',
      recipient: 'admin@repworth.com',
      template: 'partner_escalation_alert',
      externalMessageId: 'msg-ea-1',
    });

    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith('outbox-ea-1');
  });

  // ── Partner low engagement ────────────────────────────────────────

  it('partner_low_engagement: sends low-engagement email to admin', async () => {
    sqlReturnQueue.push([mockBusinessRow()]);

    await handleEngagementAlert(makeJob({
      alert_type: 'partner_low_engagement',
      metrics: {
        days_since_approval: 3,
        oldest_pending_age_days: 5,
        pending_count: 8,
        approval_rate: 25,
        notified_count: 8,
      },
    }));

    expect(mockBuildPartnerLowEngagementAlertHtml).toHaveBeenCalledOnce();
    const params = (mockBuildPartnerLowEngagementAlertHtml.mock.calls as unknown[][])[0]![0] as Record<string, unknown>;
    expect(params.businessName).toBe('Test Biz');
    expect(params.approvalRate).toBe(25);
    expect(params.pendingCount).toBe(8);
    expect(params.ownerEmail).toBe('owner@test.com');
    expect(params.ownerPhone).toBe('+1234567890');

    expect(mockSendInternalEmail).toHaveBeenCalledWith({
      to: 'admin@repworth.com',
      subject: 'Customer Test Biz approval rate dropped to 25%',
      bodyHtml: '<html>low-engagement</html>',
    });

    expect(mockRecordNotificationDelivery).toHaveBeenCalledWith({
      businessId: 'biz-1',
      channel: 'email',
      recipient: 'admin@repworth.com',
      template: 'partner_low_engagement',
      externalMessageId: 'msg-ea-1',
    });

    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith('outbox-ea-1');
  });

  // ── Error handling ────────────────────────────────────────────────

  it('fails outbox if ADMIN_NOTIFICATION_EMAIL not set for partner alerts', async () => {
    delete process.env.ADMIN_NOTIFICATION_EMAIL;
    sqlReturnQueue.push([mockBusinessRow()]);

    await handleEngagementAlert(makeJob({ alert_type: 'partner_engagement_alert' }));

    expect(mockMarkOutboxFailed).toHaveBeenCalledWith('outbox-ea-1', 'ADMIN_NOTIFICATION_EMAIL not configured');
    expect(mockSendInternalEmail).not.toHaveBeenCalled();
  });

  it('throws on email send failure (BullMQ retries)', async () => {
    sqlReturnQueue.push([mockBusinessRow()]); // business
    pushPendingReviewRows(1);                 // pending reviews
    mockSendInternalEmail.mockRejectedValueOnce(new Error('Resend API error'));

    await expect(handleEngagementAlert(makeJob({ alert_type: 'owner_nudge' }))).rejects.toThrow('Resend API error');

    expect(mockRecordNotificationDelivery).not.toHaveBeenCalled();
    expect(mockMarkOutboxCompleted).not.toHaveBeenCalled();
  });
});
