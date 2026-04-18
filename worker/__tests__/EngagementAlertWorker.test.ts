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
  mockBuildPartnerSatisfactionAlertHtml,
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
    mockBuildPartnerSatisfactionAlertHtml: vi.fn(() => '<html>satisfaction</html>'),
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
  buildPartnerSatisfactionAlertHtml: mockBuildPartnerSatisfactionAlertHtml,
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
    sqlReturnQueue.push([]);                  // idempotency check (no existing nudge)
    pushPendingReviewRows(2);                 // 2 pending reviews

    await handleEngagementAlert(makeJob({ alert_type: 'owner_nudge' }));

    // Created approval links for each pending review with revokeMode: 'orphaned_only'
    expect(mockCreateApprovalLink).toHaveBeenCalledTimes(2);
    expect(mockCreateApprovalLink).toHaveBeenCalledWith({ responseId: 'resp-1', businessId: 'biz-1', revokeMode: 'orphaned_only' });
    expect(mockCreateApprovalLink).toHaveBeenCalledWith({ responseId: 'resp-2', businessId: 'biz-1', revokeMode: 'orphaned_only' });

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
      category: 'marketing',
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

  it('owner_nudge: bounced owner short-circuits to completed BEFORE env validation (config outage safe)', async () => {
    // Regression: Finding 6 — a missing NEXT_PUBLIC_APP_URL must NOT mark a
    // bounced-owner nudge as failed. Bounced owners should always complete,
    // regardless of env state, because they will never be contacted anyway.
    delete process.env.NEXT_PUBLIC_APP_URL;
    delete process.env.RESEND_FROM_EMAIL;
    sqlReturnQueue.push([mockBusinessRow({ owner_email_bounced: true })]);

    await handleEngagementAlert(makeJob({ alert_type: 'owner_nudge' }));

    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith('outbox-ea-1');
    expect(mockMarkOutboxFailed).not.toHaveBeenCalled();
    expect(mockCreateApprovalLink).not.toHaveBeenCalled();
    expect(mockSendInternalEmail).not.toHaveBeenCalled();
  });

  it('owner_nudge: bounced owner short-circuits even when env is set (no email sent)', async () => {
    sqlReturnQueue.push([mockBusinessRow({ owner_email_bounced: true })]);

    await handleEngagementAlert(makeJob({ alert_type: 'owner_nudge' }));

    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith('outbox-ea-1');
    expect(mockMarkOutboxFailed).not.toHaveBeenCalled();
    expect(mockCreateApprovalLink).not.toHaveBeenCalled();
    expect(mockSendInternalEmail).not.toHaveBeenCalled();
  });

  it('owner_nudge: uses singular "review" for count of 1', async () => {
    sqlReturnQueue.push([mockBusinessRow()]); // business
    sqlReturnQueue.push([]);                  // idempotency check
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
      category: 'internal',
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
      category: 'internal',
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
      subject: 'Customer Test Biz approval rate is 25%',
      bodyHtml: '<html>low-engagement</html>',
      category: 'internal',
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
    sqlReturnQueue.push([]);                  // idempotency check
    pushPendingReviewRows(1);                 // pending reviews
    mockSendInternalEmail.mockRejectedValueOnce(new Error('Resend API error'));

    await expect(handleEngagementAlert(makeJob({ alert_type: 'owner_nudge' }))).rejects.toThrow('Resend API error');

    expect(mockRecordNotificationDelivery).not.toHaveBeenCalled();
    expect(mockMarkOutboxCompleted).not.toHaveBeenCalled();
  });

  // ── Partner satisfaction alert ──────────────────────────────────────

  it('sends satisfaction alert to admin with rating and comment', async () => {
    process.env.ADMIN_NOTIFICATION_EMAIL = 'admin@test.com';
    sqlReturnQueue.push([mockBusinessRow()]); // business
    sqlReturnQueue.push([]);                  // idempotency check — no existing delivery
    sqlReturnQueue.push([{ rating: 'not_great', comment: 'Response took too long' }]); // live satisfaction_responses re-read

    await handleEngagementAlert(makeJob({
      alert_type: 'partner_satisfaction_alert',
      satisfaction: {
        rating: 'not_great',
        comment: 'Response took too long',
        week_start_date: '2026-04-13',
      },
    }));

    expect(mockBuildPartnerSatisfactionAlertHtml).toHaveBeenCalledWith(expect.objectContaining({
      businessName: 'Test Biz',
      rating: 'not_great',
      comment: 'Response took too long',
      weekStartDate: '2026-04-13',
    }));
    expect(mockSendInternalEmail).toHaveBeenCalledWith(expect.objectContaining({
      to: 'admin@test.com',
      subject: expect.stringContaining('Not great'),
    }));
    expect(mockRecordNotificationDelivery).toHaveBeenCalledWith(expect.objectContaining({
      template: 'partner_satisfaction_alert:2026-04-13',
    }));
    expect(mockMarkOutboxCompleted).toHaveBeenCalled();
  });

  it('sends satisfaction alert without comment (not_great, no comment)', async () => {
    process.env.ADMIN_NOTIFICATION_EMAIL = 'admin@test.com';
    sqlReturnQueue.push([mockBusinessRow()]); // business
    sqlReturnQueue.push([]);                  // idempotency check
    sqlReturnQueue.push([{ rating: 'not_great', comment: null }]); // live re-read

    await handleEngagementAlert(makeJob({
      alert_type: 'partner_satisfaction_alert',
      satisfaction: {
        rating: 'not_great',
        comment: null,
        week_start_date: '2026-04-13',
      },
    }));

    expect(mockBuildPartnerSatisfactionAlertHtml).toHaveBeenCalledWith(expect.objectContaining({
      rating: 'not_great',
      comment: null,
    }));
    expect(mockMarkOutboxCompleted).toHaveBeenCalled();
  });

  it('skips alert when owner changed rating from not_great to ok', async () => {
    process.env.ADMIN_NOTIFICATION_EMAIL = 'admin@test.com';
    sqlReturnQueue.push([mockBusinessRow()]); // business
    sqlReturnQueue.push([]);                  // idempotency check
    sqlReturnQueue.push([{ rating: 'ok', comment: null }]); // live re-read — rating changed!

    await handleEngagementAlert(makeJob({
      alert_type: 'partner_satisfaction_alert',
      satisfaction: {
        rating: 'not_great',
        comment: 'was bad',
        week_start_date: '2026-04-13',
      },
    }));

    expect(mockSendInternalEmail).not.toHaveBeenCalled();
    expect(mockMarkOutboxCompleted).toHaveBeenCalled();
  });

  it('fails satisfaction alert when satisfaction data is missing', async () => {
    process.env.ADMIN_NOTIFICATION_EMAIL = 'admin@test.com';
    sqlReturnQueue.push([mockBusinessRow()]);

    await handleEngagementAlert(makeJob({
      alert_type: 'partner_satisfaction_alert',
      // no satisfaction field
    }));

    expect(mockMarkOutboxFailed).toHaveBeenCalledWith(expect.any(String), 'missing satisfaction payload');
    expect(mockSendInternalEmail).not.toHaveBeenCalled();
  });

  it('fails satisfaction alert when ADMIN_NOTIFICATION_EMAIL not set', async () => {
    delete process.env.ADMIN_NOTIFICATION_EMAIL;
    sqlReturnQueue.push([mockBusinessRow()]);

    await handleEngagementAlert(makeJob({
      alert_type: 'partner_satisfaction_alert',
      satisfaction: { rating: 'not_great', comment: null, week_start_date: '2026-04-13' },
    }));

    expect(mockMarkOutboxFailed).toHaveBeenCalledWith(expect.any(String), expect.stringContaining('ADMIN_NOTIFICATION_EMAIL'));
  });

  it('fails satisfaction alert with invalid rating', async () => {
    process.env.ADMIN_NOTIFICATION_EMAIL = 'admin@test.com';
    sqlReturnQueue.push([mockBusinessRow()]);

    await handleEngagementAlert(makeJob({
      alert_type: 'partner_satisfaction_alert',
      satisfaction: { rating: 'terrible' as 'not_great', comment: null, week_start_date: '2026-04-13' },
    }));

    expect(mockMarkOutboxFailed).toHaveBeenCalledWith(expect.any(String), expect.stringContaining('invalid satisfaction rating'));
    expect(mockSendInternalEmail).not.toHaveBeenCalled();
  });

  it('fails satisfaction alert with non-date-format week_start_date', async () => {
    process.env.ADMIN_NOTIFICATION_EMAIL = 'admin@test.com';
    sqlReturnQueue.push([mockBusinessRow()]);

    await handleEngagementAlert(makeJob({
      alert_type: 'partner_satisfaction_alert',
      satisfaction: { rating: 'not_great', comment: null, week_start_date: 'not-a-date' },
    }));

    expect(mockMarkOutboxFailed).toHaveBeenCalledWith(expect.any(String), expect.stringContaining('invalid satisfaction week_start_date'));
    expect(mockSendInternalEmail).not.toHaveBeenCalled();
  });

  it('fails satisfaction alert with impossible calendar date (2026-99-99)', async () => {
    process.env.ADMIN_NOTIFICATION_EMAIL = 'admin@test.com';
    sqlReturnQueue.push([mockBusinessRow()]);

    await handleEngagementAlert(makeJob({
      alert_type: 'partner_satisfaction_alert',
      satisfaction: { rating: 'not_great', comment: null, week_start_date: '2026-99-99' },
    }));

    expect(mockMarkOutboxFailed).toHaveBeenCalledWith(expect.any(String), expect.stringContaining('not a real date'));
    expect(mockSendInternalEmail).not.toHaveBeenCalled();
  });

  it('skips satisfaction alert if already sent for this business + week', async () => {
    process.env.ADMIN_NOTIFICATION_EMAIL = 'admin@test.com';
    sqlReturnQueue.push([mockBusinessRow()]);
    sqlReturnQueue.push([{ id: 'existing-delivery' }]); // idempotency check — existing delivery found

    await handleEngagementAlert(makeJob({
      alert_type: 'partner_satisfaction_alert',
      satisfaction: { rating: 'not_great', comment: null, week_start_date: '2026-04-13' },
    }));

    expect(mockSendInternalEmail).not.toHaveBeenCalled();
    expect(mockMarkOutboxCompleted).toHaveBeenCalled();
  });
});
